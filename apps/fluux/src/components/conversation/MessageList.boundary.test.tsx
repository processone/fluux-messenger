/**
 * The list boundary: views reach `MessageList` through `timeline`, `readMarkers`, `target` and a
 * command handle, and no raw scroll element or at-bottom flag crosses (FLM-51 part B).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { MessageList } from './MessageList'
import { createTestMessages } from './MessageList.test-utils'
import type { MessageListHandle, MessageListProps } from './messageListBoundary'
import type { BaseMessage } from '@fluux/sdk'
import { readMessageRowId } from './messageRowIdentity'
import { scrollStateManager } from '@/utils/scrollStateManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

// Exhaustive on purpose: adding a prop or a command to the boundary fails to compile here until
// the new name is listed, and the counts below then force the budget conversation.
const PROP_NAMES: Record<keyof MessageListProps<BaseMessage>, true> = {
  conversationId: true, timeline: true, readMarkers: true, target: true, handleRef: true,
  renderMessage: true, formatMessageForCopy: true, typing: true, lastSentMessageId: true,
  loading: true, emptyState: true, extraContent: true, staticRows: true,
}
const HANDLE_COMMANDS: Record<keyof MessageListHandle, true> = {
  requestMessageTarget: true, scrollToBottom: true, noteKeyboardNavigation: true, isAtBottom: true,
  lastVisibleRowId: true, contains: true, measureViewport: true,
}

describe('list boundary shape', () => {
  it('declares at most 13 props', () => {
    expect(Object.keys(PROP_NAMES).length).toBeLessThanOrEqual(13)
  })

  it('hands out commands and answers only, never the scroll element or the at-bottom flag', () => {
    expect(Object.keys(HANDLE_COMMANDS).sort()).toEqual([
      'contains', 'isAtBottom', 'lastVisibleRowId', 'measureViewport', 'noteKeyboardNavigation',
      'requestMessageTarget', 'scrollToBottom',
    ])
  })

  // The names are the acceptance criterion: a view that mentions either has gone around the
  // boundary again. The scan covers every view and every view-side hook that touches the list.
  it.each([
    'components/ChatView.tsx',
    'components/RoomView.tsx',
    'components/SavedPane.tsx',
    'components/SearchContextView.tsx',
    'components/StrangerRequestPreviewView.tsx',
    'hooks/useMessageSelection.ts',
    'hooks/useMessageHoverState.ts',
    'hooks/useMessageListHandle.ts',
  ])('%s does not mention scrollerRef or isAtBottomRef', file => {
    const source = readFileSync(resolve(__dirname, '../..', file), 'utf8')
    expect(source).not.toMatch(/scrollerRef|isAtBottomRef/)
  })
})

describe('list command handle', () => {
  beforeEach(() => {
    scrollStateManager.reset()
    // jsdom has no layout, so a virtualized list mounts no rows; the handle is the same either way.
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false')
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  const messages = createTestMessages(3)
  const renderMessage = (m: BaseMessage) => <div>{m.id}</div>

  function mount(extra: Partial<MessageListProps<(typeof messages)[number]>> = {}) {
    const handleRef = createRef<MessageListHandle>()
    const view = render(
      <MessageList conversationId="conv-boundary" timeline={{ messages }} renderMessage={renderMessage}
        handleRef={handleRef} {...extra} />,
    )
    return { handleRef, view }
  }

  it('is filled while the list is mounted and emptied when it unmounts', () => {
    const { handleRef, view } = mount()
    expect(handleRef.current).not.toBeNull()
    view.unmount()
    expect(handleRef.current).toBeNull()
  })

  it('answers that a live list starts at the newest message, and a keyboard move leaves it', () => {
    const { handleRef } = mount()
    expect(handleRef.current!.isAtBottom()).toBe(true)

    act(() => handleRef.current!.noteKeyboardNavigation())

    expect(handleRef.current!.isAtBottom()).toBe(false)
  })

  it('answers that a static preview does not start at the newest message', () => {
    const { handleRef } = mount({ staticRows: {} })
    expect(handleRef.current!.isAtBottom()).toBe(false)
  })

  it('reports containment of its own content only', () => {
    const { handleRef, view } = mount()
    const inside = view.container.querySelector('[data-message-row-id]')
    expect(inside).not.toBeNull()
    expect(handleRef.current!.contains(inside)).toBe(true)
    expect(handleRef.current!.contains(document.body)).toBe(false)
    expect(handleRef.current!.contains(null)).toBe(false)
  })

  it('names the lowest row overlapping the viewport', () => {
    const { handleRef, view } = mount()
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 100 } as DOMRect)
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>('[data-message-row-id]'))
    // msg-0 and msg-1 overlap the viewport, msg-2 sits below it.
    const tops = [0, 40, 400]
    rows.forEach((row, i) => { row.getBoundingClientRect = () => ({ top: tops[i], bottom: tops[i] + 30 } as DOMRect) })

    expect(rows).toHaveLength(3)
    expect(handleRef.current!.lastVisibleRowId()).toBe(readMessageRowId(rows[1]))
  })

  it('measures the viewport from the element it owns', () => {
    const { handleRef, view } = mount()
    const scroller = view.container.querySelector('[data-message-list]') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    scroller.scrollTop = 400

    expect(handleRef.current!.measureViewport()).toEqual({
      distFromBottom: 100, scrollHeight: 1000, scrollTop: 400, clientHeight: 500,
    })
  })
})
