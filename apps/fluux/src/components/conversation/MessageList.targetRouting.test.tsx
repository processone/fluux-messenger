// @vitest-environment jsdom
/**
 * Routing guard: an explicit message target belongs to the list the click happened IN.
 *
 * Reply quotes and poll cards render inside a message list, and several lists can be mounted at
 * once — the live conversation plus one non-virtualized preview per search/activity result. When
 * those clicks were routed through the module-level active-list registry (which holds exactly one
 * list), the destination depended on whichever list registered most recently:
 *
 *   - preview holding the registry → its own handler discarded the target (staticMode no-op);
 *   - live list holding the registry → a click inside the PREVIEW scrolled the live conversation.
 *
 * Both are the same defect: registration order is not containment. These tests pin the fix from
 * both directions, and the second one deliberately lets the LIVE list win the registry before
 * clicking, so it fails against the registry-routed implementation instead of passing vacuously.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { memo } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { MessageList } from './MessageList'
import { createTestMessages } from './MessageList.test-utils'
import { useRequestMessageTarget } from './messageTargetContext'
import {
  setActiveMessageListController,
  getActiveMessageListController,
} from './activeMessageListController'
import { scrollStateManager } from '@/utils/scrollStateManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
  useMessageRangeSelection: vi.fn(() => ({
    copySelectedIds: new Set<string>(),
    selectionCount: 0,
    isSelecting: false,
    selectAll: vi.fn(),
    extendTo: vi.fn(),
    clearSelection: vi.fn(),
    copySelected: vi.fn(),
  })),
}))

/**
 * Stands in for a reply quote / poll card: it resolves its handler exactly the way MessageBubble
 * and PollClosedCard do, so these tests exercise the real provider wiring rather than a stub.
 */
function JumpRow({ id, to }: { id: string; to: string }) {
  const requestMessageTarget = useRequestMessageTarget()
  return (
    <button type="button" data-testid={`jump-${id}`} onClick={() => requestMessageTarget(to)}>
      {id}
    </button>
  )
}

const messages = createTestMessages(8)
const renderMessage = (m: { id: string }) => <JumpRow id={m.id} to="msg-5" />

/** Memoized twin of JumpRow: MessageBubble is memoized too, so rows must survive an append. */
const rowRenderCounts = new Map<string, number>()
const CountingJumpRow = memo(function CountingJumpRow({ id }: { id: string }) {
  rowRenderCounts.set(id, (rowRenderCounts.get(id) ?? 0) + 1)
  const requestMessageTarget = useRequestMessageTarget()
  return (
    <button type="button" data-testid={`count-${id}`} onClick={() => requestMessageTarget('msg-0')}>
      {id}
    </button>
  )
})
const renderCountingMessage = (m: { id: string }) => <CountingJumpRow id={m.id} />

describe('MessageList explicit-target routing (containment, not registration order)', () => {
  let scrolled: Element[]
  let originalScrollIntoView: typeof Element.prototype.scrollIntoView

  beforeEach(() => {
    scrollStateManager.reset()
    setActiveMessageListController(null)
    scrolled = []
    originalScrollIntoView = Element.prototype.scrollIntoView
    // jsdom has no layout and no scrollIntoView; record the receiving element so we can assert
    // WHICH list's row was positioned, not merely that something scrolled.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    } as typeof Element.prototype.scrollIntoView
  })

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView
    setActiveMessageListController(null)
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('positions a preview click inside that preview instead of discarding it', () => {
    const { container } = render(
      <MessageList
        messages={messages}
        conversationId="preview-conv"
        renderMessage={renderMessage}
        staticMode
      />,
    )

    fireEvent.click(container.querySelector('[data-testid="jump-msg-1"]')!)

    const targetRow = container.querySelector('[data-message-id="msg-5"]')
    expect(targetRow).not.toBeNull()
    // Previously the staticMode branch returned early, so nothing scrolled at all.
    expect(scrolled).toEqual([targetRow])
    expect(targetRow!.classList.contains('message-highlight')).toBe(true)
  })

  it('never routes a preview click to the live conversation that holds the registry', () => {
    const { container } = render(
      <MessageList
        messages={messages}
        conversationId="preview-conv"
        renderMessage={renderMessage}
        staticMode
      />,
    )

    // The live conversation list re-registers after the preview mounted — the ordering that made
    // registry routing send preview clicks into the live conversation.
    const liveList = { requestMessageTarget: vi.fn(), scrollToBottom: vi.fn() }
    setActiveMessageListController(liveList)

    fireEvent.click(container.querySelector('[data-testid="jump-msg-1"]')!)

    expect(liveList.requestMessageTarget).not.toHaveBeenCalled()
    // ...and the click still did its job inside the preview, so this is not passing by inaction.
    expect(scrolled).toEqual([container.querySelector('[data-message-id="msg-5"]')])
  })

  it('registers the live list in the shared registry but never a preview', () => {
    const { unmount } = render(
      <MessageList messages={messages} conversationId="live-conv" renderMessage={renderMessage} />,
    )
    // Callers with no enclosing list (PollBanner, find-on-page) still reach the live conversation.
    expect(getActiveMessageListController()).not.toBeNull()
    unmount()

    setActiveMessageListController(null)
    render(
      <MessageList
        messages={messages}
        conversationId="preview-conv"
        renderMessage={renderMessage}
        staticMode
      />,
    )
    // A preview must not occupy the single global slot, or it would displace the live list.
    expect(getActiveMessageListController()).toBeNull()
  })
})

describe('MessageList explicit-target provider identity', () => {
  beforeEach(() => {
    scrollStateManager.reset()
    setActiveMessageListController(null)
    rowRenderCounts.clear()
    // jsdom has no layout, so the real virtualizer would window this live list down to no rows at
    // all. Force the non-virtualized path to get mounted rows to count; the callback identity this
    // test pins is shared by both paths.
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false')
  })

  afterEach(() => {
    setActiveMessageListController(null)
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('does not rerender memoized target consumers when a message is appended', () => {
    const all = createTestMessages(6)
    const resident = all.slice(0, 5)

    const { rerender } = render(
      <MessageList
        messages={resident}
        conversationId="live-conv"
        renderMessage={renderCountingMessage}
      />,
    )
    const before = new Map(rowRenderCounts)
    expect(before.size).toBe(resident.length)

    rerender(
      <MessageList
        messages={all}
        conversationId="live-conv"
        renderMessage={renderCountingMessage}
      />,
    )

    // requestMessageTarget closes over messageCount through its executor. Publishing it raw made
    // the context value change on every append, and a context update bypasses React.memo — so each
    // arriving message rerendered every mounted row.
    for (const message of resident) {
      expect(rowRenderCounts.get(message.id)).toBe(before.get(message.id))
    }
    // Control: the appended row really did mount, so the assertion above is not passing because
    // nothing rendered at all.
    expect(rowRenderCounts.get('msg-5')).toBe(1)
  })

  it('does not re-register the active list when a message is appended', () => {
    const all = createTestMessages(6)
    const resident = all.slice(0, 5)

    const { rerender } = render(
      <MessageList
        messages={resident}
        conversationId="live-conv"
        renderMessage={renderCountingMessage}
      />,
    )
    const registered = getActiveMessageListController()
    expect(registered).not.toBeNull()

    rerender(
      <MessageList
        messages={all}
        conversationId="live-conv"
        renderMessage={renderCountingMessage}
      />,
    )

    // Both published callbacks are identity-stable, so the registration effect must not re-run.
    // If either tracked messageCount again, this would be a different controller object.
    expect(getActiveMessageListController()).toBe(registered)
  })
})
