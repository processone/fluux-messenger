/**
 * @vitest-environment jsdom
 */
import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessageListScroll, type UseMessageListScrollResult } from './useMessageListScroll'
import { PositioningController } from './positioningController'
import { ViewportSession } from './viewportSession'
import { ScrollPersistenceAdapter } from './scrollPersistenceAdapter'
import { DirectionalHistoryWindowCoordinator } from './directionalHistoryWindowCoordinator'
import { scrollStateManager } from '@/utils/scrollStateManager'
import { resetScrollShadowDiagnostics } from './scrollPositionShadow'

/**
 * The commit-order guardrail for the message-list scroll hook.
 *
 * The hook turns each React commit into work for the positioning controller, the viewport session,
 * the persistence adapter and the directional-window coordinator. This test drives the real hook
 * through scripted commits (mount, append, typing, row growth, prepend, conversation switch, unread
 * marker, store target, window slide, late read pointer, unmount) and writes down every call into
 * those four objects, in order, with the scroll writes of each step.
 *
 * The whole trace is compared with a file recorded before the effect order was replaced by the
 * commit planner, so a change that reorders, drops or adds a call fails here at the first
 * differing line.
 */

class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

interface Props {
  conversationId: string
  ids: string[]
  firstNewMessageId?: string
  readPointerId?: string
  targetMessageId?: string | null
  rowGrowthSignature?: string
  hasTypingIndicator?: boolean
  lastMessageIsOutgoing?: boolean
  windowAtLiveEdge?: boolean
  isLoadingOlder?: boolean
  isLoadingNewer?: boolean
  interiorPlacementVersion?: number
  staticMode?: boolean
}

const lines: string[] = []
let apiRef: UseMessageListScrollResult | undefined
const scrollTopSets: number[] = []

function Harness(props: Props) {
  const geometry = React.useRef({ scrollHeight: 1000, clientHeight: 500 })
  const scrollTopRef = React.useRef(0)
  const api = useMessageListScroll({
    conversationId: props.conversationId,
    messageCount: props.ids.length,
    firstMessageId: props.ids[0],
    lastMessageId: props.ids.at(-1),
    firstNewMessageId: props.firstNewMessageId,
    readPointerId: props.readPointerId,
    targetMessageId: props.targetMessageId,
    rowGrowthSignature: props.rowGrowthSignature ?? '',
    hasTypingIndicator: props.hasTypingIndicator,
    lastMessageIsOutgoing: props.lastMessageIsOutgoing,
    windowAtLiveEdge: props.windowAtLiveEdge,
    isLoadingOlder: props.isLoadingOlder,
    isLoadingNewer: props.isLoadingNewer,
    interiorPlacementVersion: props.interiorPlacementVersion,
    staticMode: props.staticMode,
    onScrollToTop: () => {},
    onLoadNewer: () => {},
    clearFirstNewMessageId: () => {},
    onLoadAround: () => {},
  })
  apiRef = api
  const setRef = api.setScrollContainerRef
  const refCallback = React.useCallback((node: HTMLDivElement | null) => {
    if (node) {
      Object.defineProperty(node, 'scrollHeight', { get: () => geometry.current.scrollHeight, configurable: true })
      Object.defineProperty(node, 'clientHeight', { get: () => geometry.current.clientHeight, configurable: true })
      Object.defineProperty(node, 'scrollTop', {
        get: () => scrollTopRef.current,
        set: (value: number) => {
          scrollTopRef.current = value
          scrollTopSets.push(value)
        },
        configurable: true,
      })
      Object.defineProperty(node, 'scrollTo', {
        value: (options: ScrollToOptions | number) => {
          const top = typeof options === 'number' ? options : options.top
          if (typeof top === 'number') node.scrollTop = top
        },
        configurable: true,
      })
    }
    setRef(node)
  }, [setRef])
  return (
    <div ref={refCallback} onScroll={api.handleScroll} data-message-list>
      {props.ids.length > 0 && (
        <div ref={api.contentWrapperRef}>
          {props.ids.map((id, index) => (
            <div
              key={id}
              ref={(node) => {
                if (!node) return
                Object.defineProperty(node, 'offsetTop', { get: () => index * 40, configurable: true })
                Object.defineProperty(node, 'offsetHeight', { get: () => 40, configurable: true })
                node.getBoundingClientRect = () => new DOMRect(0, index * 40 - scrollTopRef.current, 800, 40)
              }}
              className="message-row"
              data-message-id={id}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---- spies --------------------------------------------------------------------------------------

const restorers: Array<() => void> = []
let lastLine = ''
let repeat = 0

function emit(line: string) {
  if (line === lastLine) {
    repeat += 1
    return
  }
  flushRepeat()
  lastLine = line
  lines.push(line)
}

function flushRepeat() {
  if (repeat > 0) lines.push(`  (x${repeat + 1})`)
  repeat = 0
}

function mark(text: string) {
  flushRepeat()
  lastLine = ''
  lines.push(`== ${text}`)
}

function describeArgs(args: unknown[]): string {
  const first = args[0]
  if (typeof first === 'string') return ` ${first}`
  if (first && typeof first === 'object') {
    const object = first as Record<string, unknown>
    const parts: string[] = []
    if (typeof object.conversationId === 'string') parts.push(object.conversationId)
    if (typeof object.event === 'string') parts.push(object.event)
    const source = object.source as { kind?: string; reason?: string } | undefined
    if (source?.kind) parts.push(`${source.kind}${source.reason ? `/${source.reason}` : ''}`)
    if (typeof object.reason === 'string') parts.push(object.reason)
    if (typeof object.messageId === 'string') parts.push(object.messageId)
    return parts.length ? ` ${parts.join(' ')}` : ''
  }
  return ''
}

function spyOn(cls: { name: string; prototype: object }) {
  const proto = cls.prototype as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)
    if (!descriptor || typeof descriptor.value !== 'function') continue
    const original = descriptor.value as (...args: unknown[]) => unknown
    proto[name] = function (this: unknown, ...args: unknown[]) {
      emit(`${cls.name}.${name}${describeArgs(args)}`)
      return original.apply(this, args)
    }
    restorers.push(() => { proto[name] = original })
  }
}

// ---- scenario runner ----------------------------------------------------------------------------

const ids = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `${prefix}-${from + i}`)

function runScenarios(): string {
  lines.length = 0
  lastLine = ''
  repeat = 0
  scrollTopSets.length = 0
  const base: Props = { conversationId: 'a@example.test', ids: ids('a', 10, 15) }
  let current: Props = base
  let view!: ReturnType<typeof render>
  const step = (label: string, patch: Partial<Props>) => {
    mark(label)
    current = { ...current, ...patch }
    scrollTopSets.length = 0
    act(() => { view.rerender(<Harness {...current} />) })
    flushRepeat()
    lastLine = ''
    lines.push(`   scroll writes: [${scrollTopSets.join(',')}]`)
  }

  mark('mount a (live edge entry)')
  scrollTopSets.length = 0
  view = render(<Harness {...current} />)
  flushRepeat()
  lines.push(`   scroll writes: [${scrollTopSets.join(',')}]`)

  step('append incoming', { ids: ids('a', 10, 16) })
  step('append outgoing', { ids: ids('a', 10, 17), lastMessageIsOutgoing: true })
  step('typing on', { hasTypingIndicator: true, lastMessageIsOutgoing: false })
  step('typing off', { hasTypingIndicator: false })
  step('row growth', { rowGrowthSignature: 'g1' })
  step('row growth again', { rowGrowthSignature: 'g2' })

  mark('load earlier requested')
  act(() => { apiRef?.handleLoadEarlier() })
  flushRepeat()
  step('older loading', { isLoadingOlder: true })
  step('prepend lands', { ids: [...ids('a', 5, 10), ...ids('a', 10, 17)], isLoadingOlder: false })
  step('interior arrival', { ids: [...ids('a', 5, 10), 'a-9b', ...ids('a', 10, 17)], interiorPlacementVersion: 1 })
  step('window slides off live edge', { windowAtLiveEdge: false })
  step('window returns to live edge', { windowAtLiveEdge: true })
  step('newer loading', { isLoadingNewer: true })
  step('newer settled', { isLoadingNewer: false })

  step('unread marker appears', { firstNewMessageId: 'a-12', readPointerId: 'a-11' })
  step('unread marker cleared', { firstNewMessageId: undefined, readPointerId: 'a-16' })
  step('late read pointer', { readPointerId: 'a-9b' })

  step('store target set', { targetMessageId: 'a-12' })
  step('store target re-render', { ids: [...ids('a', 5, 10), 'a-9b', ...ids('a', 10, 18)] })
  step('store target changes', { targetMessageId: 'a-7' })
  step('store target cleared', { targetMessageId: null })

  step('switch to b (saved position)', { conversationId: 'b@example.test', ids: ids('b', 0, 8) })
  step('switch to c (unread marker)', { conversationId: 'c@example.test', ids: ids('c', 0, 8), firstNewMessageId: 'c-4', readPointerId: 'c-3' })
  step('switch to d (target pending)', { conversationId: 'd@example.test', ids: ids('d', 0, 8), firstNewMessageId: undefined, targetMessageId: 'd-2' })
  step('switch back to a', { conversationId: 'a@example.test', ids: ids('a', 10, 17), targetMessageId: null })
  step('switch to empty room', { conversationId: 'e@example.test', ids: [] })
  step('empty room fills', { ids: ids('e', 0, 6) })
  step('static mode on', { staticMode: true })
  step('static append', { ids: ids('e', 0, 7) })
  step('static mode off', { staticMode: false })

  mark('unmount')
  view.unmount()
  flushRepeat()
  return lines.join('\n') + '\n'
}

describe('useMessageListScroll commit order', () => {
  let realRaf: typeof requestAnimationFrame

  beforeEach(() => {
    scrollStateManager.reset()
    resetScrollShadowDiagnostics()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    realRaf = window.requestAnimationFrame
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'queueMicrotask'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    // A saved reading position for room b and room d's history, so the switch paths take the
    // saved-position entry.
    scrollStateManager.enterConversation('b@example.test', 10)
    scrollStateManager.leaveConversation('b@example.test', 200, 1000, 500, undefined, undefined)
    for (const cls of [PositioningController, ViewportSession, ScrollPersistenceAdapter, DirectionalHistoryWindowCoordinator]) {
      spyOn(cls)
    }
  })

  afterEach(() => {
    cleanup()
    for (const restore of restorers.splice(0)) restore()
    vi.useRealTimers()
    window.requestAnimationFrame = realRaf
    vi.unstubAllGlobals()
  })

  it('calls the controller, session, persistence and window coordinator in the recorded order', async () => {
    const trace = runScenarios()
    await expect(trace).toMatchFileSnapshot('./__traces__/useMessageListScroll.commitOrder.trace.txt')
  })

  it('records the same trace on a second run', () => {
    const first = runScenarios()
    cleanup()
    scrollStateManager.reset()
    resetScrollShadowDiagnostics()
    scrollStateManager.enterConversation('b@example.test', 10)
    scrollStateManager.leaveConversation('b@example.test', 200, 1000, 500, undefined, undefined)
    expect(runScenarios()).toBe(first)
  })
})
