import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { RoomMessage } from '@fluux/sdk'
import { useFocusedVisibleRows } from './useFocusedVisibleRows'
import { messageRowId } from '@/components/conversation/messageRowIdentity'

// Source: approved room-marker send contract. Geometry and focus are DOM-boundary
// stand-ins here; the actual browser/server journey owns the live viewing claim.
const row: RoomMessage = { type: 'groupchat', id: 'reading-proof', roomJid: 'reading@conference.localhost',
  from: 'reading@conference.localhost/Bob', nick: 'Bob', occupantId: 'bob-id', stanzaId: 'archive-reading-proof',
  originId: undefined, body: 'Room reading proof', timestamp: new Date('2026-05-01T10:00:00Z'), isOutgoing: false }
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 750, width: 750, x: 0, y: top, toJSON: () => ({}) })
let notify: () => void
let focused: boolean
let scroller: HTMLDivElement
let message: HTMLDivElement
let observe: ReturnType<typeof vi.fn>
let disconnect: ReturnType<typeof vi.fn>
beforeEach(() => {
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  observe = vi.fn(); disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: () => void) { notify = callback }
    observe = observe
    disconnect = disconnect
  })
  scroller = document.createElement('div')
  message = document.createElement('div')
  message.dataset.messageRowId = messageRowId(row)
  scroller.append(message); document.body.append(scroller)
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(100, 400))
  vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect(300, 100))
})
afterEach(() => { scroller.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('focused visible room rows', () => {
  it('reports measured visible rows but never infers viewing from focus alone or detached/offscreen geometry', () => {
    const seen = vi.fn()
    const view = renderHook(() => useFocusedVisibleRows({ current: scroller }, [row], seen, true))
    notify()
    expect(seen).toHaveBeenLastCalledWith([row])
    seen.mockClear()
    focused = false
    notify()
    expect(seen).not.toHaveBeenCalled()
    focused = true
    vi.mocked(message.getBoundingClientRect).mockReturnValue(rect(600, 100))
    window.dispatchEvent(new Event('focus'))
    expect(seen).not.toHaveBeenCalled()
    vi.mocked(message.getBoundingClientRect).mockReturnValue(rect(300, 100))
    window.dispatchEvent(new Event('focus'))
    expect(seen).toHaveBeenLastCalledWith([row])
    view.unmount()
    expect(disconnect).toHaveBeenCalled()
    seen.mockClear()
    window.dispatchEvent(new Event('focus'))
    expect(seen).not.toHaveBeenCalled()
  })

  it('does not report messages covered by a modal as viewed', () => {
    const seen = vi.fn()
    const view = renderHook(() => useFocusedVisibleRows({ current: scroller }, [row], seen, true))
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    try {
      notify()
      expect(seen).not.toHaveBeenCalled()
      modal.remove()
      notify()
      expect(seen).toHaveBeenCalledWith([row])
    } finally { modal.remove(); view.unmount() }
  })

  it('does not attach viewing work for static previews or a loading list', () => {
    const seen = vi.fn()
    renderHook(() => useFocusedVisibleRows({ current: scroller }, [row], seen, false))
    expect(observe).not.toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
  })
})
