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
const appHooksIndexPath = resolve(process.cwd(), 'src/hooks/index.ts')
const appHooksIndexSource = readFileSync(appHooksIndexPath, 'utf8')
const legacyMessageScrollPath = resolve(
  process.cwd(),
  'src/hooks/useMessageScroll.ts',
)

const directMessageListWrite =
  /\bscrollRef\.current\.(?:scrollTo\s*\(|scrollTop\s*=)/

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
