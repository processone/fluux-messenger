import { render } from '@testing-library/react'
import type { BaseMessage } from '@fluux/sdk'
import { MessageList, type MessageListProps } from '../MessageList'
import { ScriptedScroller, type ScriptedScrollerOptions } from './scriptedScroller'

export function makeMessages(count: number, from = 0): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${from + i}`,
    stanzaId: undefined, originId: undefined,
    from: 'user@example.com',
    body: `Body ${from + i}`,
    timestamp: new Date(2024, 0, 1, 12, 0, 0, 0 + (from + i) * 1000),
    isOutgoing: false,
    type: 'chat' as const,
  }))
}

let conversations = 0

export interface Bench {
  scroller: ScriptedScroller
  /** The list's own scroll element. */
  element: () => HTMLElement
  update: (props: Partial<MessageListProps<BaseMessage>>) => void
  unmount: () => void
  /** The ids of the rows currently mounted, in order. */
  mountedIds: () => string[]
  /** Where a mounted row's top sits in the viewport, or null when it is not mounted. */
  viewportTop: (id: string) => number | null
  /** The first row wholly in the viewport: the one a reader would say they are looking at. */
  firstVisible: () => string
  /** The `count` mounted rows nearest above the viewport, wholly out of it. */
  rowsAbove: (count: number) => string[]
  /** The distance from the bottom of the content to the bottom of the viewport. */
  distanceFromEnd: () => number
}

/**
 * Mounts the real message list (hook, controller, browser adapters, virtualizer adapter, installed
 * library) over a scripted scroller. Call from a test; `bench.scroller.uninstall()` in afterEach.
 */
export function mountBench(
  props: Partial<MessageListProps<BaseMessage>> = {},
  options: ScriptedScrollerOptions = {},
): Bench {
  const scroller = new ScriptedScroller(options)
  scroller.install()
  const base: MessageListProps<BaseMessage> = {
    messages: makeMessages(60),
    // A conversation of its own per mount: the height cache and saved positions are keyed by it.
    conversationId: `bench-conversation-${++conversations}`,
    renderMessage: (message) => <div>{message.body}</div>,
    ...props,
  }
  const view = render(<MessageList {...base} />)
  let current = base
  const element = () => scroller.scroller!
  const bench: Bench = {
    scroller,
    element,
    update: (next) => {
      current = { ...current, ...next }
      view.rerender(<MessageList {...current} />)
    },
    unmount: () => view.unmount(),
    mountedIds: () => Array.from(element().querySelectorAll<HTMLElement>('[data-message-row-id]'))
      .map(row => row.dataset.messageRowId!),
    viewportTop: (id) => {
      const row = element().querySelector<HTMLElement>(`[data-message-row-id="${id}"]`)
      return row ? row.getBoundingClientRect().top : null
    },
    firstVisible: () => bench.mountedIds().find(id => bench.viewportTop(id)! >= 0)!,
    rowsAbove: (count) => bench.mountedIds()
      .filter(id => bench.viewportTop(id)! + scroller.rowHeight(id) <= 0).slice(-count),
    distanceFromEnd: () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
  }
  return bench
}
