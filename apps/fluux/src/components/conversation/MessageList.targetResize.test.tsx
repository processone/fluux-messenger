import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from './MessageList'
import { createTestMessages } from './MessageList.test-utils'
import { getActiveMessageListController, setActiveMessageListController } from './activeMessageListController'
import { getScrollShadowSnapshot, resetScrollShadowDiagnostics } from './scrollPositionShadow'
import { TARGET_HIGHLIGHT_MS } from './explicitTargetBrowserAdapter'
import { scrollStateManager } from '@/utils/scrollStateManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
  useMessageRangeSelection: () => ({
    copySelectedIds: new Set<string>(), selectionCount: 0, isSelecting: false,
    selectAll: vi.fn(), extendTo: vi.fn(), clearSelection: vi.fn(), copySelected: vi.fn(),
  }),
}))
vi.mock('./tanstackMessageVirtualizer', () => ({
  useTanstackMessageVirtualizer: (args: {
    items: { key: string }[]
    indexById: Map<string, number>
    scrollRef: React.RefObject<HTMLElement | null>
  }) => ({
    getVirtualItems: () => args.items.map((item, index) => ({ key: item.key, index, start: index * 40, size: 40 })),
    getTotalSize: () => 1000,
    itemCount: args.items.length,
    getIndexForMessageId: (id: string) => args.indexById.get(id) ?? null,
    getOffsetForMessageId: (id: string) => id === 'msg-19' ? 920 : 0,
    ensureMessageMounted: async () => {},
    measureElement: () => {},
    scrollToOffset: (top: number) => { if (args.scrollRef.current) args.scrollRef.current.scrollTop = top },
    beginAnimatedScrollToOffset: (top: number) => { if (args.scrollRef.current) args.scrollRef.current.scrollTop = top },
    scrollToIndex: (_index: number, options?: { align?: string }) => {
      const scroller = args.scrollRef.current
      if (scroller) scroller.scrollTop = options?.align === 'end'
        ? scroller.scrollHeight - scroller.clientHeight
        : 960 - scroller.clientHeight / 2
    },
  }),
}))

let frames: Map<number, FrameRequestCallback>
let nextFrameId: number
let observers: Set<{ elements: Set<Element>; callback: ResizeObserverCallback }>

function frame() {
  act(() => {
    for (const [id, callback] of [...frames]) {
      if (frames.delete(id)) callback(performance.now())
    }
  })
}

function settle() {
  for (let i = 0; frames.size && i < 100; i++) frame()
  expect(frames.size).toBe(0)
  expect(getScrollShadowSnapshot().instrumentationErrors).toEqual([])
}

beforeEach(() => {
  vi.useFakeTimers()
  scrollStateManager.reset()
  resetScrollShadowDiagnostics()
  setActiveMessageListController(null)
  frames = new Map()
  nextFrameId = 1
  observers = new Set()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class {
    elements = new Set<Element>()
    constructor(public callback: ResizeObserverCallback) { observers.add(this) }
    observe(element: Element) { this.elements.add(element) }
    unobserve(element: Element) { this.elements.delete(element) }
    disconnect() { this.elements.clear(); observers.delete(this) }
  })
})

afterEach(() => {
  cleanup()
  setActiveMessageListController(null)
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mountList(virtualized: boolean) {
  localStorage.setItem('fluux:flags:enableMessageVirtualization', String(virtualized))
  const geometry = { height: 1000, client: 600, top: 0 }
  let messages = createTestMessages(20).map(message => ({ ...message, isOutgoing: false }))
  let typingUsers: string[] = []
  let conversationId = 'target-resize-a'
  let key = 'list'
  let withholdEvents = false
  const writes: number[] = []
  const nativeEvents: number[] = []
  const consumed = vi.fn()
  const loadAround = vi.fn()
  const props = () => ({ messages, typingUsers, conversationId, onTargetMessageConsumed: consumed, onLoadAround: loadAround })
  const renderMessage = (message: { body?: string }) => <span>{message.body}</span>
  const view = render(<MessageList key={key} {...props()} renderMessage={renderMessage} />)
  let scroller: HTMLDivElement
  let target: HTMLElement
  const instrument = () => {
    scroller = view.container.querySelector<HTMLDivElement>('[data-message-list]')!
    target = scroller.querySelector<HTMLElement>('[data-message-id="msg-19"]')!
    Object.defineProperties(scroller, {
      scrollTop: {
        configurable: true,
        get: () => geometry.top,
        set: (top: number) => {
          writes.push(top)
          const clamped = Math.max(0, Math.min(top, geometry.height - geometry.client))
          if (clamped === geometry.top) return
          geometry.top = clamped
          if (!withholdEvents) requestAnimationFrame(() => fireEvent.scroll(scroller))
        },
      },
      scrollHeight: { configurable: true, get: () => geometry.height },
      clientHeight: { configurable: true, get: () => geometry.client },
      clientWidth: { configurable: true, get: () => 794 },
    })
    scroller.getBoundingClientRect = () => new DOMRect(0, 100, 800, geometry.client)
    scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      scroller.scrollTop = typeof options === 'number' ? y ?? geometry.top : options?.top ?? geometry.top
    }
    scroller.addEventListener('scroll', () => nativeEvents.push(geometry.top))
    Object.defineProperties(target, {
      offsetTop: { configurable: true, get: () => 920 },
      offsetHeight: { configurable: true, get: () => 80 },
    })
    target.getBoundingClientRect = () => new DOMRect(0, 1020 - geometry.top, 780, 80)
    target.scrollIntoView = () => { scroller.scrollTop = 960 - geometry.client / 2 }
  }
  const resize = () => act(() => {
    for (const observer of observers) {
      if (observer.elements.has(scroller)) observer.callback([
        {
          target: scroller,
          contentRect: new DOMRect(0, 0, 800, geometry.client),
          borderBoxSize: [{ inlineSize: 800, blockSize: geometry.client }],
          contentBoxSize: [{ inlineSize: 800, blockSize: geometry.client }],
          devicePixelContentBoxSize: [{ inlineSize: 800, blockSize: geometry.client }],
        },
      ], observer as unknown as ResizeObserver)
    }
  })
  const rerender = () => view.rerender(<MessageList key={key} {...props()} renderMessage={renderMessage} />)
  instrument()
  resize()
  settle()
  const jump = () => {
    act(() => getActiveMessageListController()!.requestMessageTarget('msg-19'))
    settle()
  }
  jump()
  expect(geometry.top).toBe(400)
  act(() => vi.advanceTimersByTime(TARGET_HIGHLIGHT_MS))
  writes.length = 0
  return {
    get scroller() { return scroller },
    geometry, writes, nativeEvents,
    jump,
    withholdEvents: () => { withholdEvents = true },
    showTyping: (client = 557) => {
      geometry.client = client
      typingUsers = ['Alice']
      rerender()
      resize()
    },
    hideTyping: () => {
      geometry.client = 600
      geometry.top = Math.min(geometry.top, geometry.height - geometry.client)
      typingUsers = []
      rerender()
      resize()
      fireEvent.scroll(scroller)
    },
    append: () => {
      geometry.height += 60
      const incoming = createTestMessages(messages.length + 1).at(-1)!
      messages = [...messages, { ...incoming, isOutgoing: false }]
      rerender()
    },
    replace: (element: boolean) => {
      conversationId = 'target-resize-b'
      if (element) key = 'replacement'
      rerender()
      if (element) instrument()
      resize()
      settle()
    },
    nativeScroll: (top: number) => { geometry.top = top; fireEvent.scroll(scroller) },
    assertNoNavigationSideEffects: () => {
      expect(consumed).not.toHaveBeenCalled()
      expect(loadAround).not.toHaveBeenCalled()
      expect(target).not.toHaveClass('message-highlight')
    },
  }
}

function press(scroller: HTMLDivElement, kind: 'touch' | 'scrollbar') {
  if (kind === 'touch') {
    fireEvent.touchStart(scroller)
    return () => fireEvent.touchEnd(window)
  }
  fireEvent.pointerDown(scroller, { button: 0, clientX: 795, clientY: 300 })
  return () => fireEvent.pointerUp(window, { button: 0 })
}

describe.each([false, true])('MessageList target resize lifecycle (virtualized: %s)', (virtualized) => {
  it.each(['touch', 'scrollbar'] as const)('preserves pending %s through the typing render and an arrival', (kind) => {
    const scope = mountList(virtualized)
    const element = scope.scroller
    const release = press(element, kind)
    scope.showTyping()
    scope.append()
    settle()
    expect(scope.scroller).toBe(element)
    expect(scope.geometry.top).toBe(400)
    expect(scope.writes).toEqual([])
    release()
    settle()
    expect(scope.geometry.top).toBe(443)
    scope.append()
    settle()
    expect(scope.geometry.top).toBe(443)
    scope.assertNoNavigationSideEffects()
  })

  it('keeps fixed targeting across a clamp when correction events are withheld', () => {
    const scope = mountList(virtualized)
    scope.withholdEvents()
    const eventsBefore = scope.nativeEvents.length
    scope.showTyping()
    settle()
    expect(scope.geometry.top).toBe(443)
    expect(scope.nativeEvents).toHaveLength(eventsBefore)
    act(() => vi.advanceTimersByTime(300))
    scope.hideTyping()
    settle()
    expect(scope.geometry.top).toBe(400)
    scope.append()
    settle()
    expect(scope.geometry.top).toBe(400)
    scope.showTyping()
    settle()
    expect(scope.geometry.top).toBe(443)
    scope.assertNoNavigationSideEffects()
  })

  it('honors late native upward movement after release and an unchanged frame', () => {
    const scope = mountList(virtualized)
    const release = press(scope.scroller, 'scrollbar')
    act(() => vi.advanceTimersByTime(21))
    release()
    act(() => vi.advanceTimersByTime(14))
    frame()
    expect(scope.geometry.top).toBe(400)
    act(() => vi.advanceTimersByTime(21))
    scope.nativeScroll(214)
    scope.showTyping()
    scope.append()
    settle()
    expect(scope.geometry.top).toBe(214)
    expect(scope.writes).toEqual([])
  })

  it.each([false, true])('drops old input on conversation replacement (new element: %s)', (newElement) => {
    const scope = mountList(virtualized)
    const element = scope.scroller
    const release = press(element, 'touch')
    scope.replace(newElement)
    expect(scope.scroller === element).toBe(!newElement)
    scope.jump()
    act(() => vi.advanceTimersByTime(TARGET_HIGHLIGHT_MS))
    release()
    scope.showTyping()
    settle()
    expect(scope.geometry.top).toBe(443)
    scope.append()
    settle()
    expect(scope.geometry.top).toBe(443)
    scope.assertNoNavigationSideEffects()
  })
})
