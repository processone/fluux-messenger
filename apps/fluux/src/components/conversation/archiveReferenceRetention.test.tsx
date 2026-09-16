// @vitest-environment jsdom
import { useLayoutEffect, type UIEvent } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import { useMessageListScroll, type UseMessageListScrollResult } from './useMessageListScroll'
import { messageRowId } from './messageRowIdentity'
import type { MessageVirtualizer } from './messageVirtualizer'
import { scrollStateManager } from '@/utils/scrollStateManager'
import { getScrollShadowSnapshot, resetScrollShadowDiagnostics } from './scrollPositionShadow'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren() })

it('keeps the archive-selected occupant row through a real TanStack overscan change', () => {
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
  const flush = () => {
    for (let frame = 0; frames.size && frame < 100; frame++) act(() => {
      vi.advanceTimersByTime(16)
      for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(performance.now())
    })
    expect(frames.size).toBe(0)
    expect(getScrollShadowSnapshot().instrumentationErrors).toEqual([])
  }
  const selectedId = messageRowId({ id: 'shared-client', occupantId: 'occupant-b' })!
  const otherId = messageRowId({ id: 'shared-client', occupantId: 'occupant-a' })!
  const items = Array.from({ length: 80 }, (_, index) => ({ key: index === 59 ? selectedId : index === 58 ? otherId : `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  indexById.set('shared-client', 58)
  const scroller = document.body.appendChild(document.createElement('div'))
  const scrollRef = { current: scroller }
  let virtualizer: MessageVirtualizer | undefined
  let scroll: UseMessageListScrollResult | undefined
  Object.defineProperties(scroller, {
    offsetHeight: { get: () => 400 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 400 },
    clientWidth: { get: () => 800 }, scrollHeight: { get: () => virtualizer?.getTotalSize() ?? 1600 },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 400)
  scroller.scrollTo = options => {
    const next = Math.max(0, Math.min((options as ScrollToOptions).top ?? 0, scroller.scrollHeight - 400))
    if (next !== scroller.scrollTop) {
      scroller.scrollTop = next
      requestAnimationFrame(() => scroller.dispatchEvent(new Event('scroll')))
    }
  }
  scroller.addEventListener('scroll', () => scroll?.handleScroll({ currentTarget: scroller } as UIEvent<HTMLDivElement>))
  const row = (index: number, height = 20) => {
    const element = scroller.appendChild(document.createElement('div'))
    element.dataset.index = String(index)
    element.dataset.messageRowId = items[index].key
    element.dataset.messageId = index === 58 || index === 59 ? 'shared-client' : items[index].key
    Object.defineProperty(element, 'offsetHeight', { get: () => height })
    element.getBoundingClientRect = () => new DOMRect(0, (virtualizer?.getOffsetForMessageId(items[index].key) ?? index * 20) - scroller.scrollTop, 800, height)
    element.scrollIntoView = () => scroller.scrollTo({ top: index * 20 - 190 })
    return element
  }
  row(58)
  const selected = row(59)
  selected.dataset.stanzaId = 'archive:closed-poll'
  const hook = renderHook(() => {
    useLayoutEffect(() => {
      const attach = scroll!.setScrollContainerRef
      attach(scroller)
      return () => attach(null)
    }, [])
    virtualizer = useTanstackMessageVirtualizer({ items, indexById, scrollRef, estimateSize: 20,
      onMeasured: (_key, height) => scroll?.handleVirtualRowMeasuredGrowth('room', height - 20),
    })
    scroll = useMessageListScroll({ conversationId: 'room', messageCount: 80, firstMessageId: 'row-0', lastMessageId: 'row-79', rowGrowthSignature: '', virtualizer })
    return { virtualizer, scroll }
  })
  flush()
  act(() => hook.result.current.scroll.requestMessageTarget('archive:closed-poll'))
  flush()
  expect(selected.classList.contains('message-highlight')).toBe(true)
  const grown = row(41, 1200)
  act(() => hook.result.current.virtualizer.measureElement(grown))
  expect(hook.result.current.virtualizer.getTotalSize()).toBe(2780)
  const keys = hook.result.current.virtualizer.getVirtualItems().map(item => item.key)
  expect(keys).toContain(selectedId)
  expect(keys).not.toContain(otherId)
  flush()
  expect(selected.getBoundingClientRect().bottom).toBeLessThanOrEqual(400)
  expect(selected.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
})
