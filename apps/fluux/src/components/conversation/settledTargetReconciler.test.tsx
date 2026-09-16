// @vitest-environment jsdom
import { useLayoutEffect, type UIEvent } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import { useMessageListScroll, type UseMessageListScrollResult } from './useMessageListScroll'
import type { MessageVirtualizer } from './messageVirtualizer'
import { scrollStateManager } from '@/utils/scrollStateManager'
import { getScrollShadowSnapshot, resetScrollShadowDiagnostics } from './scrollPositionShadow'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren() })

it.each(['tail', 'archive:tail'])('retires queued centering after settling %s, preserving visible position on arrivals', reference => {
  vi.useFakeTimers()
  scrollStateManager.reset()
  resetScrollShadowDiagnostics()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const step = () => act(() => {
    const [id, callback] = frames.entries().next().value!
    frames.delete(id)
    vi.advanceTimersByTime(16)
    callback(performance.now())
  })
  const flush = () => {
    for (let i = 0; frames.size && i < 200; i++) step()
    expect(frames.size).toBe(0)
    expect(getScrollShadowSnapshot().instrumentationErrors).toEqual([])
  }
  let items = [{ key: 'prefix', height: 920 }, { key: 'tail', height: 80 }]
  const scroller = document.body.appendChild(document.createElement('div'))
  const scrollRef = { current: scroller }
  let virtualizer: MessageVirtualizer | undefined
  let scroll: UseMessageListScrollResult | undefined
  Object.defineProperties(scroller, {
    offsetHeight: { get: () => 600 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 600 },
    clientWidth: { get: () => 800 }, scrollHeight: { get: () => virtualizer?.getTotalSize() ?? 1000 },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
  scroller.scrollTo = options => {
    const next = Math.max(0, Math.min((options as ScrollToOptions).top ?? 0, scroller.scrollHeight - 600))
    if (next !== scroller.scrollTop) {
      scroller.scrollTop = next
      requestAnimationFrame(() => scroller.dispatchEvent(new Event('scroll')))
    }
  }
  scroller.addEventListener('scroll', () => scroll?.handleScroll({ currentTarget: scroller } as UIEvent<HTMLDivElement>))
  const target = scroller.appendChild(document.createElement('div'))
  target.dataset.messageId = 'tail'
  target.dataset.stanzaId = 'archive:tail'
  target.getBoundingClientRect = () => new DOMRect(0, 920 - scroller.scrollTop, 800, 80)
  const hook = renderHook(() => {
    useLayoutEffect(() => {
      const attach = scroll!.setScrollContainerRef
      attach(scroller)
      return () => attach(null)
    }, [])
    virtualizer = useTanstackMessageVirtualizer({ items, indexById: new Map(items.map((item, index) => [item.key, index])), scrollRef, estimateSize: index => items[index].height })
    scroll = useMessageListScroll({ conversationId: 'room', messageCount: items.length, firstMessageId: 'prefix', lastMessageId: items.at(-1)!.key, rowGrowthSignature: '', virtualizer })
    return scroll
  })
  flush()
  act(() => hook.result.current.requestMessageTarget(reference))
  for (let i = 0; !target.classList.contains('message-highlight') && i < 200; i++) step()
  expect(target.classList.contains('message-highlight')).toBe(true)
  expect(scroller.scrollTop).toBe(400)
  expect(frames.size).toBeGreaterThan(0)
  items = [...items, { key: 'arrival', height: 60 }]
  hook.rerender()
  expect(scroller.scrollHeight).toBe(1060)
  flush()
  expect(scroller.scrollTop).toBe(400)
  expect(target.getBoundingClientRect().bottom).toBe(600)
  items = [...items, { key: 'later', height: 100 }]
  hook.rerender()
  flush()
  expect(scroller.scrollTop).toBe(400)
})
