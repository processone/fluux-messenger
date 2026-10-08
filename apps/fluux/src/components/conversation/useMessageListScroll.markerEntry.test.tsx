// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AT_BOTTOM_THRESHOLD, scrollStateManager } from '@/utils/scrollStateManager'
import { messageRowId } from './messageRowIdentity'
import type { MessageVirtualizer } from './messageVirtualizer'
import { resetScrollShadowDiagnostics } from './scrollPositionShadow'
import { useMessageListScroll } from './useMessageListScroll'
import { useMessageSelection } from '@/hooks/useMessageSelection'

let frames: Map<number, FrameRequestCallback>
let nextFrame: number

function runFrame() {
  act(() => {
    for (const [id, callback] of [...frames]) {
      if (frames.delete(id)) callback(performance.now())
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  frames = new Map()
  nextFrame = 0
  scrollStateManager.reset()
  resetScrollShadowDiagnostics()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * A first open on an unread divider whose native scroll events are withheld, as WebKit does for
 * programmatic scrolls: only the events this test delivers reach the handler.
 */
function markerEntry({ bottomFraction = 0, contentKind = 'system-notice', markerIndex = 40 } = {}) {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const message = { id: `message-${index}`, occupantId: `occupant-${index}`, stanzaId: `archive-${index}` }
    return { ...message, rowId: messageRowId(message)!, top: index * 100, height: 100 }
  })
  const geometry = { top: 0, height: 6_000, client: 500 }
  const onLiveEdgeMeasured = vi.fn()
  const clearFirstNewMessageId = vi.fn()
  const selectionScrollRef: React.RefObject<HTMLElement | null> = { current: null }
  const scrollToMarker = { current: () => {} }
  const showScrollToBottom = { current: false }
  let hasTypingIndicator = false
  let rowGrowthSignature = ''
  let scroller!: HTMLDivElement
  let writeObserver: Parameters<NonNullable<MessageVirtualizer['setScrollWriteObserver']>>[0]
  const write = (top: number) => {
    if (writeObserver?.({ phase: 'before', source: 'navigation' }) === false) return
    scroller.scrollTop = top
    writeObserver?.({ phase: 'after', source: 'navigation' })
  }
  const virtualizer: MessageVirtualizer = {
    get itemCount() { return rows.length },
    getVirtualItems: () => rows.map((row, index) => ({ index, key: row.rowId, start: row.top, size: row.height })),
    getTotalSize: () => geometry.height,
    getIndexForMessageId: id => {
      const index = rows.findIndex(row => row.rowId === id)
      return index < 0 ? null : index
    },
    getOffsetForMessageId: id => rows.find(row => row.rowId === id)?.top ?? null,
    ensureMessageMounted: async () => {},
    measureElement: () => {},
    scrollToOffset: top => write(top),
    scrollToIndex: index => write(rows[index].top),
    beginAnimatedScrollToOffset: top => write(top),
    cancelPendingScroll: () => write(scroller.scrollTop),
    setScrollWriteObserver: observer => { writeObserver = observer },
  }
  const marker = rows[markerIndex].rowId

  function HookHarness() {
    const result = useMessageListScroll({
      conversationId: 'room-a',
      messageCount: rows.length,
      firstMessageId: rows[0].rowId,
      firstNewMessageId: marker,
      lastMessageId: rows.at(-1)!.rowId,
      rowGrowthSignature,
      hasTypingIndicator,
      windowAtLiveEdge: true,
      virtualizer,
      onLiveEdgeMeasured,
      clearFirstNewMessageId,
    })
    const selection = useMessageSelection(rows, selectionScrollRef, {
      getRowId: row => row.rowId,
      onKeyboardScrolled: () => result.observeKeyboardNavigation('room-a'),
    })
    React.useLayoutEffect(() => {
      scrollToMarker.current = result.scrollToMarker
    }, [result.scrollToMarker])
    React.useLayoutEffect(() => {
      showScrollToBottom.current = result.showScrollToBottom
    }, [result.showScrollToBottom])
    const setContainer = result.setScrollContainerRef
    const setScroller = React.useCallback((node: HTMLDivElement | null) => {
      if (node) {
        scroller = node
        Object.defineProperties(node, {
          scrollTop: {
            configurable: true,
            get: () => geometry.top,
            set: (top: number) => { geometry.top = Math.max(0, Math.min(top, geometry.height - geometry.client + bottomFraction)) },
          },
          scrollHeight: { configurable: true, get: () => geometry.height },
          clientHeight: { configurable: true, get: () => geometry.client },
          clientWidth: { configurable: true, value: 780 },
        })
        node.getBoundingClientRect = () => new DOMRect(0, 100, 800, geometry.client)
        node.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
          node.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? 0
        }
      }
      selectionScrollRef.current = node
      setContainer(node)
    }, [setContainer])
    return <div onKeyDown={selection.handleKeyDown} tabIndex={0}><div ref={setScroller} data-message-list onWheel={result.handleWheel} onScroll={result.handleScroll}>
      <div ref={result.contentWrapperRef}>
        {rows.map(row => <div key={row.rowId} data-message-id={row.id} data-message-row-id={row.rowId}
          className="message-row" ref={node => {
            if (!node) return
            Object.defineProperties(node, {
              offsetTop: { configurable: true, get: () => row.top },
              offsetHeight: { configurable: true, get: () => row.height },
            })
            node.getBoundingClientRect = () => new DOMRect(0, 100 + row.top - geometry.top, 800, row.height)
            node.scrollIntoView = () => {
              if (row.top < geometry.top) scroller.scrollTop = row.top
              else if (row.top + row.height > geometry.top + geometry.client) {
                scroller.scrollTop = row.top + row.height - geometry.client
              }
            }
          }}>
            <div>{contentKind}</div>
          </div>)}
      </div>
    </div></div>
  }

  const view = render(<HookHarness />)
  return {
    geometry, rows, onLiveEdgeMeasured, clearFirstNewMessageId,
    scrollToMarker: () => scrollToMarker.current(),
    get showScrollToBottom() { return showScrollToBottom.current },
    get scroller() { return scroller },
    /** Rows below the reader measure taller; scrollTop does not move, so no scroll event follows. */
    growBelow: (height: number) => {
      rows.at(-1)!.height += height
      geometry.height += height
    },
    /** Every row re-estimated at `height`: the content shrinks and the browser clamps scrollTop. */
    recalibrate: (height: number) => {
      rows.forEach((row, index) => { row.top = index * height; row.height = height })
      geometry.height = rows.length * height
      geometry.top = Math.min(geometry.top, geometry.height - geometry.client + bottomFraction)
    },
    growViewport: (client: number) => {
      geometry.client = client
      geometry.top = Math.min(geometry.top, geometry.height - geometry.client + bottomFraction)
    },
    growLastRow: (height: number) => {
      rows.at(-1)!.height += height
      geometry.height += height
      rowGrowthSignature = `growth-${geometry.height}`
      view.rerender(<HookHarness />)
    },
    showTyping: () => {
      hasTypingIndicator = true
      geometry.client -= 30
      view.rerender(<HookHarness />)
    },
    arrive: () => {
      const message = { id: `arrival-${rows.length}`, occupantId: 'arrival-occupant', stanzaId: `arrival-archive-${rows.length}` }
      rows.push({ ...message, rowId: messageRowId(message)!, top: geometry.height, height: 100 })
      geometry.height += 100
      view.rerender(<HookHarness />)
    },
  }
}

it('shows the scroll-to-bottom button immediately when a marker landing is outside the following band', () => {
  const entry = markerEntry({ markerIndex: 53 })
  runFrame()
  expect(entry.scroller.scrollTop).toBe(5_300)
  const distance = entry.scroller.scrollHeight - entry.scroller.scrollTop - entry.scroller.clientHeight
  expect(distance).toBe(200)
  expect(distance).toBeGreaterThan(AT_BOTTOM_THRESHOLD)
  expect(entry.onLiveEdgeMeasured).not.toHaveBeenCalledWith(true)
  expect(entry.showScrollToBottom).toBe(true)

  entry.growBelow(200)
  for (let frame = 0; frame < 20; frame += 1) runFrame()

  expect(entry.scroller.scrollTop).toBe(5_300)
  expect(entry.showScrollToBottom).toBe(true)
})

it('refreshes the scroll-to-bottom button when content growth moves a marker landing outside the following band without a scroll event', () => {
  const entry = markerEntry({ markerIndex: 54 })
  runFrame()
  expect(entry.scroller.scrollTop).toBe(5_400)
  const distance = entry.scroller.scrollHeight - entry.scroller.scrollTop - entry.scroller.clientHeight
  expect(distance).toBe(100)
  expect(distance).toBeLessThan(AT_BOTTOM_THRESHOLD)
  expect(entry.showScrollToBottom).toBe(false)

  entry.growBelow(200)
  for (let frame = 0; frame < 20; frame += 1) runFrame()

  expect(entry.scroller.scrollTop).toBe(5_400)
  expect(entry.scroller.scrollHeight - entry.scroller.scrollTop - entry.scroller.clientHeight).toBe(300)
  expect(entry.showScrollToBottom).toBe(true)
})

it('takes no bottom evidence from a recalibration clamp and does not pin the next arrival', () => {
  const entry = markerEntry()
  runFrame()
  expect(entry.scroller.scrollTop).toBe(4_000)

  // The first measurement recalibrates the estimates of every row: the content shrinks under the
  // landing and the browser clamps scrollTop to the new bottom while the marker loop owns it.
  entry.recalibrate(60)
  expect(entry.scroller.scrollTop).toBe(3_100)
  fireEvent.scroll(entry.scroller)
  for (let frame = 0; frame < 20; frame += 1) runFrame()
  const readerTop = entry.scroller.scrollTop
  expect(readerTop).toBe(2_400)

  entry.arrive()
  for (let frame = 0; frame < 80; frame += 1) runFrame()

  expect(entry.onLiveEdgeMeasured).not.toHaveBeenCalledWith(true)
  expect(entry.scroller.scrollTop).toBe(readerTop)
})

it.each(['content', 'viewport'].flatMap(change =>
  [-0.25, 0.25].map(bottomFraction => ({ change, bottomFraction })),
))('holds a cancelled marker through $change clamps at $bottomFraction rounding', ({ change, bottomFraction }) => {
  const entry = markerEntry({ bottomFraction })
  runFrame()
  expect(entry.scroller.scrollTop).toBe(4000)
  fireEvent.touchStart(entry.scroller, { touches: [{ identifier: 1, clientY: 400 }] })
  fireEvent.touchEnd(entry.scroller, { touches: [] })
  if (change === 'content') entry.recalibrate(60)
  else entry.growViewport(2900)
  fireEvent.scroll(entry.scroller)
  for (let frame = 0; frame < 20; frame += 1) runFrame()
  expect(entry.scroller.scrollTop).toBe(3100 + bottomFraction)

  entry.growLastRow(20)
  fireEvent.scroll(entry.scroller)
  entry.showTyping()
  fireEvent.scroll(entry.scroller)
  entry.arrive()
  fireEvent.scroll(entry.scroller)
  for (let frame = 0; frame < 80; frame += 1) runFrame()
  entry.arrive()
  fireEvent.scroll(entry.scroller)

  expect(entry.scroller.scrollTop).toBe(3100 + bottomFraction)
  expect(entry.onLiveEdgeMeasured).not.toHaveBeenCalledWith(true)
  expect(entry.onLiveEdgeMeasured).toHaveBeenCalledWith(false)

  fireEvent.wheel(entry.scroller, { deltaY: 300 })
  entry.scroller.scrollTop = entry.geometry.height
  fireEvent.scroll(entry.scroller)
  expect(entry.onLiveEdgeMeasured).not.toHaveBeenCalledWith(true)
  runFrame()
  expect(entry.onLiveEdgeMeasured).toHaveBeenCalledWith(true)
  entry.arrive()
  for (let frame = 0; frame < 80; frame += 1) runFrame()
  expect(Math.abs(entry.scroller.scrollTop - (entry.geometry.height - entry.geometry.client))).toBeLessThan(1)
})

it.each(['wheel', 'touch', 'keyboard', 'scrollbar'] as const)(
  'follows arrivals after real %s movement reaches the bottom following cancellation', input => {
    const entry = markerEntry({ bottomFraction: -0.25 })
    runFrame()
    fireEvent.touchStart(entry.scroller, { touches: [] })
    fireEvent.touchEnd(entry.scroller, { touches: [] })
    entry.recalibrate(60)
    fireEvent.scroll(entry.scroller)
    runFrame()
    entry.growLastRow(400)
    fireEvent.scroll(entry.scroller)
    expect(entry.onLiveEdgeMeasured).not.toHaveBeenCalledWith(true)

    if (input === 'wheel') fireEvent.wheel(entry.scroller, { deltaY: 400 })
    if (input === 'touch') {
      fireEvent.touchStart(entry.scroller, { touches: [{ identifier: 1, clientY: 500 }] })
      fireEvent.touchMove(entry.scroller, { touches: [{ identifier: 1, clientY: 100 }] })
    }
    if (input === 'keyboard') fireEvent.keyDown(entry.scroller, { key: 'PageDown', code: 'PageDown' })
    if (input === 'scrollbar') {
      fireEvent(entry.scroller, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 790, clientY: 200 }))
      fireEvent(window, new MouseEvent('pointermove', { clientX: 790, clientY: 400 }))
    }
    entry.scroller.scrollTop += 100
    fireEvent.scroll(entry.scroller)
    expect(entry.onLiveEdgeMeasured).not.toHaveBeenCalledWith(true)
    entry.scroller.scrollTop = entry.geometry.height - entry.geometry.client
    fireEvent.scroll(entry.scroller)
    expect(entry.onLiveEdgeMeasured).not.toHaveBeenCalledWith(true)

    if (input === 'touch') fireEvent.touchEnd(entry.scroller, { touches: [] })
    if (input === 'keyboard') fireEvent.keyUp(entry.scroller, { key: 'PageDown', code: 'PageDown' })
    if (input === 'scrollbar') fireEvent(window, new MouseEvent('pointerup'))
    runFrame()
    expect(entry.onLiveEdgeMeasured).toHaveBeenCalledWith(true)
    entry.arrive()
    for (let frame = 0; frame < 80; frame += 1) runFrame()
    expect(entry.scroller.scrollTop).toBe(entry.geometry.height - entry.geometry.client - 0.25)
  },
)

it('clears an armed marker when keyboard release observes the bottom before its scroll event', () => {
  const entry = markerEntry()
  for (let frame = 0; frame < 20; frame += 1) runFrame()
  fireEvent.keyDown(entry.scroller, { key: 'PageDown', code: 'PageDown' })
  entry.scroller.scrollTop += 100
  fireEvent.scroll(entry.scroller)
  expect(entry.clearFirstNewMessageId).not.toHaveBeenCalled()
  entry.scroller.scrollTop = entry.geometry.height - entry.geometry.client
  fireEvent.keyUp(entry.scroller, { key: 'PageDown', code: 'PageDown' })
  expect(entry.onLiveEdgeMeasured).toHaveBeenCalledWith(true)
  expect(entry.clearFirstNewMessageId).not.toHaveBeenCalled()
  fireEvent.scroll(entry.scroller)
  expect(entry.clearFirstNewMessageId).toHaveBeenCalledOnce()
})

it.each(['attachment', 'retracted', 'encryption', 'system-notice'])('lands immediately on textless %s rows on entry and navigation', contentKind => {
  const entry = markerEntry({ contentKind })
  runFrame()
  expect(entry.scroller.scrollTop).toBe(4000)
  for (let frame = 0; frame < 20; frame += 1) runFrame()
  expect(entry.scroller.scrollTop).toBe(4000)
  fireEvent.wheel(entry.scroller, { deltaY: -100 })
  entry.scroller.scrollTop = 1000
  fireEvent.scroll(entry.scroller)
  act(() => entry.scrollToMarker())
  for (let frame = 0; frame < 20; frame += 1) runFrame()
  expect(entry.scroller.scrollTop).toBe(4000)
  expect(entry.onLiveEdgeMeasured).not.toHaveBeenCalledWith(true)
})

it.each([false, true])('releases marker hold only when keyboard selection reaches the edge: %s', reachesEdge => {
  const entry = markerEntry()
  runFrame()
  expect(entry.scroller.scrollTop).toBe(4000)
  const zone = entry.scroller.parentElement!
  zone.focus()
  for (let step = 0; step < (reachesEdge ? 16 : 2); step += 1) {
    fireEvent.keyDown(zone, { key: 'ArrowDown' })
  }
  const readerTop = entry.scroller.scrollTop
  expect(readerTop).toBe(reachesEdge ? 5500 : 4100)
  if (reachesEdge) expect(entry.onLiveEdgeMeasured).toHaveBeenCalledWith(true)
  else expect(entry.onLiveEdgeMeasured).not.toHaveBeenCalledWith(true)
  entry.arrive()
  for (let frame = 0; frame < 20; frame += 1) runFrame()
  expect(entry.scroller.scrollTop).toBe(reachesEdge ? 5600 : readerTop)
})
