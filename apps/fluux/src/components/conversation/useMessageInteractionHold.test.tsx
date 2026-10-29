// @vitest-environment jsdom
// Intent: FLM-229 requires deliberate input, not content moving beneath a resting pointer.
import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessageInteractionHold } from './useMessageInteractionHold'

let container: HTMLDivElement
let row: HTMLDivElement
let action: HTMLButtonElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  container = document.createElement('div')
  row = document.createElement('div')
  row.dataset.messageRowId = 'archive-row:["original",null,"archive-42"]'
  row.innerHTML = '<div data-message-toolbar><button>More options</button></div><div data-message-body>Original message</div>'
  action = row.querySelector('button')!
  container.append(row)
  document.body.append(container)
})
afterEach(() => { container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
function setup() {
  const begin = vi.fn(() => true)
  const release = vi.fn()
  const scrollRef = { current: container }
  const hook = renderHook(({ conversationId }) => useMessageInteractionHold({
    scrollRef, conversationId, enabled: true, begin, release,
  }), { initialProps: { conversationId: 'emma@fluux.chat' } })
  return { ...hook, begin, release }
}
function mouse(type: string, target: Element, x = 100, y = 200) {
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })) })
}
function moveIntoRow() {
  mouse('mousemove', document.body, 10, 10)
  mouse('mousemove', row, 100, 200)
}

describe('deliberate message interaction', () => {
  it('does not hold when a row enters under a resting pointer, even with a zero-motion mousemove', () => {
    const { begin, result } = setup()
    mouse('mousemove', document.body)
    mouse('mouseover', row)
    mouse('mouseenter', row)
    mouse('mousemove', row)
    act(() => vi.advanceTimersByTime(500))
    expect(begin).not.toHaveBeenCalled()
    expect(result.current.context.heldMessageId).toBeNull()
  })
  it('holds immediately on physical movement, before the toolbar display delay', () => {
    const { begin, result } = setup()
    moveIntoRow()
    expect(begin).toHaveBeenCalledWith(row.dataset.messageRowId)
    expect(result.current.context.heldMessageId).toBe(row.dataset.messageRowId)
    mouse('mousemove', row)
    expect(begin).toHaveBeenCalledTimes(1)
  })
  it('does not count a stale movement delta at unchanged screen coordinates as new intent', () => {
    const { result, begin } = setup()
    moveIntoRow()
    act(() => result.current.cancel())
    const event = new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 200 })
    Object.defineProperty(event, 'movementX', { value: 90 })
    act(() => row.dispatchEvent(event))
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldMessageId).toBeNull()
  })
  it('observes departure and mouseup even when a nested control stops bubbling', () => {
    const { release } = setup()
    const outside = document.createElement('button')
    container.append(outside)
    outside.addEventListener('mousemove', event => event.stopPropagation())
    outside.addEventListener('mouseup', event => event.stopPropagation())
    mouse('mousedown', row)
    mouse('mousemove', outside, 0, 0)
    mouse('mouseup', outside, 0, 0)
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
  })

  it('does not mistake a row-mounted confirmation dialog for pointer interest in the message', () => {
    const { release } = setup()
    const modal = document.createElement('div')
    modal.dataset.modal = 'true'
    modal.innerHTML = '<button>Cancel</button>'
    row.append(modal)
    moveIntoRow()
    mouse('mousemove', modal.querySelector('button')!, 0, 0)
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
  })

  it('keeps the same physical row held when its bare identity gains an archive id', () => {
    row.dataset.messageRowId = 'original'
    row.dataset.messageId = 'original'
    const { result, release, rerender } = setup()
    moveIntoRow()
    row.dataset.messageRowId = 'archive-row:["original",null,"archive-42"]'
    rerender({ conversationId: 'emma@fluux.chat' })
    mouse('mousemove', row)
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.context.heldRow).toBe(row)
    expect(release).not.toHaveBeenCalled()
  })
  it('closes instead of retargeting when a known archive identity changes on the same element', () => {
    const { result, release, rerender } = setup()
    moveIntoRow()
    row.dataset.messageRowId = 'archive-row:["original",null,"different-archive"]'
    rerender({ conversationId: 'emma@fluux.chat' })
    expect(result.current.context.heldMessageId).toBeNull()
    expect(release).toHaveBeenCalledWith(true)
  })

  it('a click supplies intent without any preceding movement', () => {
    const { begin } = setup()
    mouse('mousedown', row)
    expect(begin).toHaveBeenCalledTimes(1)
  })
  it('keyboard action focus supplies intent and retains the hold after pointer departure', () => {
    const { begin, release } = setup()
    act(() => action.focus())
    expect(begin).toHaveBeenCalledTimes(1)
    mouse('mouseout', row)
    act(() => vi.advanceTimersByTime(200))
    expect(release).not.toHaveBeenCalled()
  })
  it('keeps the open panel after leaving, then releases once closed', () => {
    const { result, release } = setup()
    const close = vi.fn()
    act(() => result.current.context.setMenuOpen(row.dataset.messageRowId!, true, close))
    mouse('mousemove', document.body)
    act(() => vi.advanceTimersByTime(200))
    expect(release).not.toHaveBeenCalled()
    act(() => result.current.context.setMenuOpen(row.dataset.messageRowId!, false, close))
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
  })
  it('allows a panel to close after hover capability changes', () => {
    const { result, release } = setup()
    const close = vi.fn()
    act(() => result.current.context.setMenuOpen(row.dataset.messageRowId!, true, close))
    mouse('mousemove', document.body, 0, 0)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    act(() => result.current.context.setMenuOpen(row.dataset.messageRowId!, false, close))
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
  })

  it('bridges pointer transitions and releases only after departure', () => {
    const { release } = setup()
    moveIntoRow()
    mouse('mouseout', row)
    act(() => vi.advanceTimersByTime(50))
    mouse('mousemove', action, 105, 190)
    act(() => vi.advanceTimersByTime(100))
    expect(release).not.toHaveBeenCalled()
    mouse('mousemove', document.body, 0, 0)
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
  })
  it('does not release in the middle of a text-selection drag', () => {
    const { release } = setup()
    mouse('mousedown', row)
    mouse('mousemove', document.body, 0, 0)
    act(() => vi.advanceTimersByTime(200))
    expect(release).not.toHaveBeenCalled()
    mouse('mouseup', document.body)
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
  })
  it.each(['disabled', 'unmounted'])('releases ownership and pending callbacks when %s', async mode => {
    const begin = vi.fn(() => true), release = vi.fn()
    const scrollRef = { current: container }
    const view = renderHook(({ enabled }) => useMessageInteractionHold({
      conversationId: 'emma@fluux.chat', scrollRef, enabled, begin, release,
    }), { initialProps: { enabled: true } })
    moveIntoRow()
    fireEvent.focusOut(row.querySelector('button')!)
    if (mode === 'disabled') view.rerender({ enabled: false })
    else view.unmount()
    await Promise.resolve()
    act(() => vi.advanceTimersByTime(200))
    fireEvent(window, new Event('blur'))
    expect(release).toHaveBeenCalledExactlyOnceWith(false)
    expect(begin).toHaveBeenCalledOnce()
  })

  it('cancels menus on blur using the saved-following policy without resting-pointer reacquisition', () => {
    const { result, release, begin } = setup()
    const close = vi.fn()
    act(() => result.current.context.setMenuOpen(row.dataset.messageRowId!, true, close))
    act(() => window.dispatchEvent(new Event('blur')))
    mouse('mouseover', row)
    expect(close).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(true)
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldMessageId).toBeNull()
  })
  it('clears a removed target instead of transferring to a replacement with the same id', () => {
    const { result, rerender, release } = setup()
    moveIntoRow()
    const replacement = row.cloneNode(true)
    row.replaceWith(replacement)
    rerender({ conversationId: 'emma@fluux.chat' })
    expect(result.current.context.heldMessageId).toBeNull()
    expect(release).toHaveBeenCalledWith(true)
  })
})

// Captain's FLM-245 fixes: native drag termination and composer intent must not leave stale holds.
describe('FLM-245 interaction cleanup', () => {
  it.each(['dragend', 'drop'])('clears dragging on %s without a mouseup', type => {
    const { result, release } = setup()
    mouse('mousedown', row)
    mouse('mousemove', document.body, 0, 0)
    act(() => vi.advanceTimersByTime(200))
    expect(release).not.toHaveBeenCalled()
    act(() => document.body.dispatchEvent(new Event(type, { bubbles: true })))
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.context.heldMessageId).toBeNull()
    expect(release).toHaveBeenCalledWith(true)
    moveIntoRow()
    expect(result.current.context.heldRow).toBe(row)
  })
  it('keeps a stable selector context while the held membership changes', () => {
    const { result } = setup()
    const context = result.current.context
    const observed = vi.fn()
    const unsubscribe = context.subscribe(observed)
    moveIntoRow()
    expect(result.current.context).toBe(context)
    expect(context.isHeld(row)).toBe(true)
    act(() => result.current.cancel())
    expect(result.current.context).toBe(context)
    expect(context.isHeld(row)).toBe(false)
    expect(observed).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
  it('does not reacquire before the physical drag ends, even without a mousemove button mask', () => {
    const { result, begin } = setup()
    mouse('mousedown', row)
    act(() => result.current.cancel())
    act(() => row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 210, buttons: 0 })))
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldMessageId).toBeNull()
  })
  it('G3 resumes saved following while real autoscroll suppresses pointer reacquisition', () => {
    const { result, release, begin } = setup()
    moveIntoRow()
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1, buttons: 4 })))
    act(() => row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1, buttons: 0 })))
    mouse('mousemove', row, 130, 220)
    expect(release).toHaveBeenCalledWith(true)
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldMessageId).toBeNull()
    mouse('mousedown', row)
    expect(result.current.context.heldRow).toBe(row)
  })
  it('G3 ordinary middle-click auxclick ends the hover block without another click or key', () => {
    const { result, release, begin } = setup()
    moveIntoRow()
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1, buttons: 4 })))
    act(() => row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1, buttons: 0 })))
    act(() => row.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1, buttons: 0 })))
    mouse('mousemove', row, 130, 220)
    expect(release).toHaveBeenCalledWith(true)
    expect(begin).toHaveBeenCalledTimes(2)
    expect(result.current.context.heldRow).toBe(row)
  })
  it('G3 clears an autoscroll block when the browser consumes the stopping mousedown but delivers mouseup', () => {
    const { result } = setup()
    moveIntoRow()
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1, buttons: 4 })))
    act(() => row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 })))
    mouse('mousemove', row, 130, 220)
    expect(result.current.context.heldRow).toBe(row)
  })
  it.each(['pointer', 'click', 'keyboard', 'menu'])('FLM-245 G2: composer input releases %s holds unless a menu is open', intent => {
    const { result, release } = setup()
    const input = document.createElement('textarea')
    input.className = 'message-input'
    document.body.append(input)
    try {
      moveIntoRow()
      if (intent === 'click') { mouse('mousedown', row); mouse('mouseup', row) }
      if (intent === 'keyboard') { fireEvent.keyDown(action, { key: 'Tab' }); act(() => action.focus()) }
      if (intent === 'menu') act(() => result.current.context.setMenuOpen(row.dataset.messageRowId!, true, vi.fn()))
      fireEvent.input(input, { target: { value: 'A reply in progress' } })
      if (intent !== 'menu') {
        expect(result.current.context.heldMessageId).toBeNull()
        expect(release).toHaveBeenCalledWith(true)
      } else {
        expect(result.current.context.heldRow).toBe(row)
        expect(release).not.toHaveBeenCalled()
      }
    } finally { input.remove() }
  })
})
