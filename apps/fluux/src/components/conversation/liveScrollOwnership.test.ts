import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const chatViewSource = readFileSync(
  resolve(process.cwd(), 'src/components/ChatView.tsx'),
  'utf8',
)
const roomViewSource = readFileSync(
  resolve(process.cwd(), 'src/components/RoomView.tsx'),
  'utf8',
)
const hookSource = readFileSync(
  resolve(
    process.cwd(),
    'src/components/conversation/useMessageListScroll.ts',
  ),
  'utf8',
)
const activeControllerSource = readFileSync(
  resolve(
    process.cwd(),
    'src/components/conversation/activeMessageListController.ts',
  ),
  'utf8',
)
const viewportSessionSource = readFileSync(
  resolve(
    process.cwd(),
    'src/components/conversation/viewportSession.ts',
  ),
  'utf8',
)
const scrollPersistenceAdapterSource = readFileSync(
  resolve(
    process.cwd(),
    'src/components/conversation/scrollPersistenceAdapter.ts',
  ),
  'utf8',
)
const appHooksIndexPath = resolve(process.cwd(), 'src/hooks/index.ts')
const appHooksIndexSource = readFileSync(appHooksIndexPath, 'utf8')
const legacyMessageScrollPath = resolve(
  process.cwd(),
  'src/hooks/useMessageScroll.ts',
)

const directMessageListWrite =
  /\bscrollRef\.current\.(?:scrollTo\s*\(|scrollTop\s*=)/
const directScrollPersistenceCall =
  /\bscrollStateManager\.(?:clearSavedScrollState|saveScrollPosition|leaveConversation|markAsLeft|isInitialized|enterConversation|getSavedScrollTop|getSavedAnchor|getSavedReadPositionId)\s*\(/

function interfaceMemberNames(
  sourceText: string,
  interfaceName: string,
): string[] {
  const source = ts.createSourceFile(
    'ownership-guard.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === interfaceName,
  )
  if (!declaration) throw new Error(`missing ${interfaceName}`)
  return declaration.members
    .map((member) => member.name?.getText(source))
    .filter((name): name is string => name !== undefined)
    .sort()
}

const allowedHookFunctions = [
  'bottomVisibleMessageId',
  'contentWrapperRef',
  'handleLoadEarlier',
  'handleMediaLoad',
  'handleScroll',
  'handleWheel',
  'markerAboveViewport',
  'requestMessageTarget',
  'scrollToBottom',
  'scrollToMarker',
  'scrollToTop',
  'setScrollContainerRef',
  'showScrollToBottom',
].sort()

describe('live message-list scroll ownership', () => {
  it('does not retain or export the retired generic message-list scroll owner', () => {
    expect(existsSync(legacyMessageScrollPath)).toBe(false)
    expect(appHooksIndexSource).not.toMatch(/\buseMessageScroll\b/)
  })

  it('keeps ChatView and RoomView from writing the live message-list position directly', () => {
    expect(chatViewSource).not.toMatch(directMessageListWrite)
    expect(roomViewSource).not.toMatch(directMessageListWrite)
  })

  it('does not restore post-send or composer-resize callback escape hatches', () => {
    expect(chatViewSource).not.toMatch(/\bonMessageSent\b/)
    expect(chatViewSource).not.toMatch(/\bonInputResize\b/)
    expect(roomViewSource).not.toMatch(/\bonMessageSent\b/)
    expect(roomViewSource).not.toMatch(/\bonInputResize\b/)
  })

  it('keeps the viewport session observation-only', () => {
    expect(viewportSessionSource).not.toMatch(/\b(?:HTMLElement|Element|MessageVirtualizer)\b/)
    expect(viewportSessionSource).not.toMatch(/\b(?:scrollTop|scrollTo|scrollIntoView)\b/)
    expect(viewportSessionSource).not.toMatch(/\brequestAnimationFrame\b/)
  })

  it('keeps scroll persistence behind its adapter boundary', () => {
    expect(hookSource).not.toMatch(directScrollPersistenceCall)
  })

  it('keeps the persistence adapter value-only and unable to position', () => {
    expect(scrollPersistenceAdapterSource).not.toMatch(
      /\b(?:HTMLElement|Element|MessageVirtualizer)\b/,
    )
    expect(scrollPersistenceAdapterSource).not.toMatch(
      /\b(?:scrollTo|scrollIntoView|requestAnimationFrame)\b/,
    )
    expect(scrollPersistenceAdapterSource).not.toMatch(
      /\.scrollTop\s*=/,
    )
  })

  it('persists the outgoing viewport before resetting the session for entry', () => {
    const leave = hookSource.indexOf(
      'scrollPersistenceRef.current?.leaveConversation',
    )
    const reset = hookSource.indexOf(
      'viewportSessionRef.current?.enterConversation',
    )

    expect(leave).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(leave)
  })

  it('would reject resetting entry evidence before persisting the room left', () => {
    const wrongOrder = `
      viewportSessionRef.current?.enterConversation(nextConversationId)
      scrollPersistenceRef.current?.leaveConversation(previousConversationId)
    `

    expect(
      wrongOrder.indexOf('viewportSessionRef.current?.enterConversation'),
    ).toBeLessThan(
      wrongOrder.indexOf('scrollPersistenceRef.current?.leaveConversation'),
    )
  })

  it('would reject a direct scroll-state-manager save from the hook', () => {
    expect(
      directScrollPersistenceCall.test(
        'scrollStateManager.saveScrollPosition(conversationId, top, height, client)',
      ),
    ).toBe(true)
  })

  it('would reject a viewport session that acquired a pixel-write port', () => {
    const competingOwner = `
      class ViewportSession {
        apply(scroller: HTMLElement) {
          scroller.scrollTop = 0
        }
      }
    `
    expect(competingOwner).toMatch(/\bHTMLElement\b/)
    expect(competingOwner).toMatch(/\bscrollTop\b/)
  })

  it('routes room media through the callback supplied by MessageList', () => {
    const renderStart = roomViewSource.indexOf('const renderMessage =')
    const listStart = roomViewSource.indexOf('return (\n    <MessageList', renderStart)
    expect(renderStart).toBeGreaterThan(-1)
    expect(listStart).toBeGreaterThan(renderStart)
    const renderMessageSource = roomViewSource.slice(renderStart, listStart)

    expect(renderMessageSource).toContain('onMediaLoad: () => void')
    expect(renderMessageSource).toContain('onMediaLoad={onMediaLoad}')
  })

  it('exports only reviewed semantic commands and event/ref adapters from the live scroll hook', () => {
    expect(
      interfaceMemberNames(hookSource, 'UseMessageListScrollResult'),
    ).toEqual(allowedHookFunctions)
    expect(
      interfaceMemberNames(
        activeControllerSource,
        'ActiveMessageListController',
      ),
    ).toEqual(['requestMessageTarget', 'scrollToBottom'])
  })

  it('would reject a low-level anchor callback hidden behind the hook API', () => {
    const escaped = interfaceMemberNames(
      `
        interface UseMessageListScrollResult {
          scrollToBottom: () => void
          restoreAnchor: (anchor: unknown) => boolean
        }
      `,
      'UseMessageListScrollResult',
    )

    expect(escaped).toContain('restoreAnchor')
    expect(escaped).not.toEqual(allowedHookFunctions)
  })

  it('would fail against both former direct-write shapes', () => {
    expect(directMessageListWrite.test(
      'scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight })',
    )).toBe(true)
    expect(directMessageListWrite.test(
      'scrollRef.current.scrollTop = scrollRef.current.scrollHeight',
    )).toBe(true)
  })
})
