import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { RoomMessage } from '@fluux/sdk'
import { useFocusedVisibleRows } from './useFocusedVisibleRows'
import { useViewportObserver } from './useViewportObserver'
import { messageRowId } from '@/components/conversation/messageRowIdentity'

// Source: issue #1453's focused-view and shared-observer contract. The browser
// journey owns actual layout; this exercises the shared observer's DOM boundary.
const row: RoomMessage = { type: 'groupchat', id: 'reading-proof', roomJid: 'reading@conference.localhost',
  from: 'reading@conference.localhost/Bob', nick: 'Bob', occupantId: 'bob-id', stanzaId: 'archive-reading-proof',
  originId: undefined, body: 'Room reading proof', timestamp: new Date('2026-05-01T10:00:00Z'), isOutgoing: false }
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 750, width: 750, x: 0, y: top, toJSON: () => ({}) })
let notify: () => void
let deliver: () => void
let focused: boolean
let scroller: HTMLDivElement
let message: HTMLDivElement
let observe: ReturnType<typeof vi.fn>
let disconnect: ReturnType<typeof vi.fn>
function useViewing(seen: (rows: readonly RoomMessage[]) => void, enabled = true, rows: readonly RoomMessage[] = [row]) {
  const ref = { current: scroller }
  const viewed = useFocusedVisibleRows(ref, rows, seen, enabled)
  useViewportObserver({ scrollContainerRef: ref, conversationId: row.roomJid, onVisibleRows: viewed, enabled })
}
beforeEach(() => {
  focused = true
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  observe = vi.fn(); disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      deliver = () => callback([{
        target: message, isIntersecting: true, boundingClientRect: message.getBoundingClientRect(),
        intersectionRect: message.getBoundingClientRect(), rootBounds: scroller.getBoundingClientRect(),
        intersectionRatio: 1, time: performance.now(),
      }], this as unknown as IntersectionObserver)
      notify = () => act(() => { deliver(); vi.runOnlyPendingTimers() })
    }
    observe = observe
    unobserve = vi.fn()
    takeRecords = () => []
    disconnect = disconnect
  })
  scroller = document.createElement('div')
  message = document.createElement('div')
  message.dataset.messageRowId = messageRowId(row)
  message.dataset.messageId = row.id
  scroller.append(message); document.body.append(scroller)
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(100, 400))
  vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect(300, 100))
})
afterEach(() => { scroller.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('focused visible room rows', () => {
  it('reports measured rows, never focus alone or offscreen geometry, and stops on teardown', () => {
    const seen = vi.fn()
    const view = renderHook(() => useViewing(seen))
    notify()
    expect(seen).toHaveBeenLastCalledWith([row])
    seen.mockClear()
    focused = false
    notify()
    expect(seen).not.toHaveBeenCalled()
    focused = true
    vi.mocked(message.getBoundingClientRect).mockReturnValue(rect(600, 100))
    window.dispatchEvent(new Event('focus'))
    notify()
    expect(seen).not.toHaveBeenCalled()
    vi.mocked(message.getBoundingClientRect).mockReturnValue(rect(300, 100))
    window.dispatchEvent(new Event('focus'))
    expect(seen).not.toHaveBeenCalled()
    notify()
    expect(seen).toHaveBeenLastCalledWith([row])
    view.unmount()
    expect(disconnect).toHaveBeenCalled()
    seen.mockClear()
    window.dispatchEvent(new Event('focus'))
    expect(seen).not.toHaveBeenCalled()
  })

  it.each(['aria-modal', 'data-modal'])('recovers after %s dialogs close without a scroll or refocus', async attribute => {
    const seen = vi.fn()
    const view = renderHook(() => useViewing(seen))
    const modal = document.createElement('div')
    modal.setAttribute(attribute, 'true')
    await act(async () => { document.body.append(modal) })
    try {
      notify()
      expect(seen).not.toHaveBeenCalled()
      await act(async () => { modal.remove() })
      act(() => vi.runOnlyPendingTimers())
      expect(seen).toHaveBeenCalledWith([row])
    } finally { modal.remove(); view.unmount() }
  })

  it('recovers when the inert phone participants pane clears without a scroll or refocus', async () => {
    const seen = vi.fn()
    const view = renderHook(() => useViewing(seen))
    await act(async () => { scroller.setAttribute('inert', '') })
    notify()
    expect(seen).not.toHaveBeenCalled()
    await act(async () => { scroller.removeAttribute('inert') })
    act(() => vi.runOnlyPendingTimers())
    expect(seen).toHaveBeenCalledWith([row])
    view.unmount()
  })

  it('runs the existing read writer before peer viewing when both callbacks become due in one burst', () => {
    let read = ''
    const viewed = vi.fn(() => expect(read).toBe('second-row'))
    const view = renderHook(() => useViewportObserver({ scrollContainerRef: { current: scroller }, conversationId: row.roomJid,
      onMessageSeen: id => { read = id }, onVisibleRows: viewed }))
    act(() => {
      deliver()
      message = document.createElement('div')
      message.dataset.messageRowId = 'second-row'
      message.dataset.messageId = 'second-client-id'
      scroller.append(message)
      vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect(400, 100))
      deliver()
      vi.runOnlyPendingTimers()
    })
    expect(viewed).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('orders measured rows by their bottom edge when an upper row enters after a lower row', () => {
    const earlier = { ...row, id: 'earlier-row', stanzaId: 'earlier-archive' }
    const seen = vi.fn()
    const view = renderHook(() => useViewing(seen, true, [row, earlier]))
    act(() => {
      deliver()
      message = document.createElement('div')
      message.dataset.messageRowId = messageRowId(earlier)
      message.dataset.messageId = earlier.id
      scroller.append(message)
      vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect(150, 100))
      deliver()
      vi.runOnlyPendingTimers()
    })
    expect(seen).toHaveBeenLastCalledWith([earlier, row])
    view.unmount()
  })

  it('waits for the deferred read writer when its interval ends after the viewing report', () => {
    let read = ''
    const viewed = vi.fn((ids: readonly string[]) => expect(read).toBe(ids.at(-1)))
    const view = renderHook(() => useViewportObserver({ scrollContainerRef: { current: scroller }, conversationId: row.roomJid,
      onMessageSeen: id => { read = id }, onVisibleRows: viewed }))
    act(() => {
      const started = Date.now()
      deliver()
      vi.advanceTimersToNextTimer()
      const gap = (Date.now() - started) / 3
      viewed.mockClear()
      deliver() // same row starts a viewing window without another read write
      vi.advanceTimersByTime(gap)
      const add = (id: string, top: number) => {
        message = document.createElement('div')
        message.dataset.messageRowId = id
        message.dataset.messageId = id
        scroller.append(message)
        vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect(top, 50))
        deliver()
      }
      add('middle-row', 400)
      vi.advanceTimersByTime(gap)
      add('last-row', 450)
      vi.advanceTimersToNextTimer() // viewing is due before the deferred write
      expect(viewed).not.toHaveBeenCalled()
      vi.advanceTimersToNextTimer()
    })
    expect(viewed).toHaveBeenCalledTimes(1)
    expect(viewed.mock.calls[0][0].at(-1)).toBe('last-row')
    view.unmount()
  })

  it('does not attach viewing work for previews or loading lists', () => {
    const seen = vi.fn()
    renderHook(() => useViewing(seen, false))
    expect(observe).not.toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
  })
})
