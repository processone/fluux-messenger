// @vitest-environment jsdom
// Intent: the approved interaction policy acquires on press or keyboard action focus, never hover.
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
function hoverIntoRow() {
  mouse('mousemove', document.body, 10, 10)
  mouse('mousemove', row, 100, 200)
}

function pressRow() {
  hoverIntoRow()
  mouse('mousedown', row)
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
  it('holds on primary press before click activation, not on passive movement', () => {
    const { begin, result } = setup()
    hoverIntoRow()
    expect(begin).not.toHaveBeenCalled()
    mouse('mousedown', row)
    expect(begin).toHaveBeenCalledWith(row.dataset.messageRowId, undefined)
    expect(result.current.context.heldMessageId).toBe(row.dataset.messageRowId)
    mouse('mousemove', row)
    expect(begin).toHaveBeenCalledTimes(1)
  })
  it('does not count a stale movement delta at unchanged screen coordinates as new intent', () => {
    const { result, begin } = setup()
    pressRow()
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

  it('releases a pointer-only hold on completion even over the jump-to-latest FAB', () => {
    const { release, result } = setup()
    const fab = document.createElement('div')
    fab.innerHTML = '<button data-fab="scroll-to-bottom">Scroll to bottom</button>'
    document.body.append(fab)
    pressRow()
    mouse('mouseout', row)
    act(() => { row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: fab.firstElementChild })) })
    mouse('mousemove', fab.firstElementChild!, 600, 400)
    mouse('mousemove', fab.firstElementChild!, 602, 401)
    mouse('mouseup', fab.firstElementChild!)
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
    expect(result.current.context.heldMessageId).toBeNull()
    mouse('mousemove', document.body, 10, 10)
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
    fab.remove()
  })
  it('does not start a hold from the FAB alone', () => {
    const { begin } = setup()
    const fab = document.createElement('button')
    fab.dataset.fab = 'scroll-to-bottom'
    document.body.append(fab)
    mouse('mousemove', document.body, 10, 10)
    mouse('mousemove', fab, 600, 400)
    expect(begin).not.toHaveBeenCalled()
    fab.remove()
  })

  it('does not mistake a row-mounted confirmation dialog for pointer interest in the message', () => {
    const { release } = setup()
    const modal = document.createElement('div')
    modal.dataset.modal = 'true'
    modal.innerHTML = '<button>Cancel</button>'
    row.append(modal)
    pressRow()
    mouse('mousemove', modal.querySelector('button')!, 0, 0)
    mouse('mouseup', modal.querySelector('button')!)
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
  })

  it('keeps the same physical row held when its bare identity gains an archive id', () => {
    row.dataset.messageRowId = 'original'
    row.dataset.messageId = 'original'
    const { result, release, rerender } = setup()
    pressRow()
    row.dataset.messageRowId = 'archive-row:["original",null,"archive-42"]'
    rerender({ conversationId: 'emma@fluux.chat' })
    mouse('mousemove', row)
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.context.heldRow).toBe(row)
    expect(release).not.toHaveBeenCalled()
  })
  it('closes instead of retargeting when a known archive identity changes on the same element', () => {
    const { result, release, rerender } = setup()
    pressRow()
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
  it('refreshes a same-row pointer action after keyboard focus without replacing the held row', () => {
    const { begin, result } = setup()
    act(() => action.focus())
    const reply = document.createElement('button')
    reply.textContent = 'Reply'
    row.querySelector('[data-message-toolbar]')!.append(reply)
    mouse('mousedown', reply)
    expect(begin).toHaveBeenLastCalledWith(row.dataset.messageRowId, reply)
    expect(begin).toHaveBeenCalledTimes(2)
    expect(result.current.context.heldRow).toBe(row)
  })
  it('ignores touch compatibility mouse events even when hover capability is available', () => {
    const { begin, result } = setup()
    const event = new Event('pointerdown', { bubbles: true })
    Object.assign(event, { pointerType: 'touch', isPrimary: true, button: 0, pointerId: 1, clientX: 100, clientY: 200 })
    fireEvent(action, event)
    mouse('mousedown', action)
    act(() => action.focus())
    mouse('mouseup', action)
    expect(begin).not.toHaveBeenCalled()
    expect(result.current.context.heldRow).toBeNull()
  })
  it('does not leave a plain message click sticky under the pointer', () => {
    const { result, release } = setup()
    pressRow()
    mouse('mouseup', row)
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.context.heldRow).toBeNull()
    expect(release).toHaveBeenCalledExactlyOnceWith(true)
    hoverIntoRow()
    expect(result.current.context.heldRow).toBeNull()
  })
  it('protects selected message text until departure or selection clearing', () => {
    const { result, release } = setup()
    pressRow()
    const selection = document.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(row.querySelector('[data-message-body]')!)
    selection.removeAllRanges()
    selection.addRange(range)
    mouse('mouseup', row)
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.context.heldRow).toBe(row)
    act(() => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.context.heldRow).toBeNull()
    expect(release).toHaveBeenCalledExactlyOnceWith(true)
  })
  it('keyboard action focus supplies intent and retains the hold after pointer departure', () => {
    const { begin, release } = setup()
    act(() => action.focus())
    expect(begin).toHaveBeenCalledTimes(1)
    mouse('mouseout', row)
    act(() => vi.advanceTimersByTime(200))
    expect(release).not.toHaveBeenCalled()
  })
  it('retains a restored keyboard opener that stayed focused after pointer cancellation', () => {
    const { result, release } = setup()
    mouse('mousedown', action)
    act(() => action.focus())
    mouse('mousemove', document.body, 0, 0)
    act(() => vi.advanceTimersByTime(100))
    mouse('mouseup', document.body)
    expect(result.current.context.heldRow).toBeNull()
    expect(document.activeElement).toBe(action)
    const close = vi.fn()
    act(() => result.current.context.setMenuOpen(row.dataset.messageRowId!, true, close))
    fireEvent.keyDown(action, { key: 'Escape' })
    act(() => {
      result.current.context.setMenuOpen(row.dataset.messageRowId!, false, close)
      action.focus()
    })
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.context.heldRow).toBe(row)
    expect(release).toHaveBeenCalledExactlyOnceWith(true)
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
    pressRow()
    mouse('mouseout', row)
    act(() => vi.advanceTimersByTime(50))
    mouse('mousemove', action, 105, 190)
    act(() => vi.advanceTimersByTime(100))
    expect(release).not.toHaveBeenCalled()
    mouse('mousemove', document.body, 0, 0)
    mouse('mouseup', document.body)
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
  })
  it('releases a pointer-only press on departure before mouseup', () => {
    const { result, release } = setup()
    mouse('mousedown', action)
    mouse('mousemove', document.body, 0, 0)
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.context.heldRow).toBeNull()
    expect(release).toHaveBeenCalledExactlyOnceWith(true)
    mouse('mouseup', document.body)
  })
  it('does not release in the middle of a text-selection drag', () => {
    const { release } = setup()
    mouse('mousedown', row)
    const selection = document.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(row.querySelector('[data-message-body]')!)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    mouse('mousemove', document.body, 0, 0)
    act(() => vi.advanceTimersByTime(200))
    expect(release).not.toHaveBeenCalled()
    mouse('mouseup', document.body)
    act(() => vi.advanceTimersByTime(100))
    expect(release).toHaveBeenCalledWith(true)
    selection.removeAllRanges()
  })
  it.each(['disabled', 'unmounted'])('releases ownership and pending callbacks when %s', async mode => {
    const begin = vi.fn(() => true), release = vi.fn()
    const scrollRef = { current: container }
    const view = renderHook(({ enabled }) => useMessageInteractionHold({
      conversationId: 'emma@fluux.chat', scrollRef, enabled, begin, release,
    }), { initialProps: { enabled: true } })
    pressRow()
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
    pressRow()
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
    row.draggable = true
    mouse('mousedown', row)
    fireEvent.dragStart(row)
    mouse('mousemove', document.body, 0, 0)
    act(() => vi.advanceTimersByTime(200))
    expect(release).not.toHaveBeenCalled()
    act(() => document.body.dispatchEvent(new Event(type, { bubbles: true })))
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.context.heldMessageId).toBeNull()
    expect(release).toHaveBeenCalledWith(true)
    pressRow()
    expect(result.current.context.heldRow).toBe(row)
  })
  it('keeps a stable selector context while the held membership changes', () => {
    const { result } = setup()
    const context = result.current.context
    const observed = vi.fn()
    const unsubscribe = context.subscribe(observed)
    pressRow()
    expect(result.current.context).toBe(context)
    expect(context.isHeld(row)).toBe(true)
    act(() => result.current.cancel())
    expect(result.current.context).toBe(context)
    expect(context.isHeld(row)).toBe(false)
    expect(observed).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
  it('passive movement cannot reacquire a canceled press', () => {
    const { result, begin } = setup()
    mouse('mousedown', row)
    act(() => result.current.cancel())
    act(() => row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 210, buttons: 0 })))
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldMessageId).toBeNull()
  })
  it('a middle press requests eligible release and passive movement cannot reacquire', () => {
    const { result, release, begin } = setup()
    pressRow()
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1, buttons: 4 })))
    act(() => row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1, buttons: 0 })))
    mouse('mousemove', row, 130, 220)
    expect(release).toHaveBeenCalledWith(true)
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldMessageId).toBeNull()
    mouse('mousedown', row)
    expect(result.current.context.heldRow).toBe(row)
  })
  it('does not reacquire on hover after an ordinary middle-click auxclick', () => {
    const { result, release, begin } = setup()
    pressRow()
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1, buttons: 4 })))
    act(() => row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1, buttons: 0 })))
    act(() => row.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1, buttons: 0 })))
    mouse('mousemove', row, 130, 220)
    expect(release).toHaveBeenCalledWith(true)
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldRow).toBeNull()
    mouse('mousedown', row)
    expect(result.current.context.heldRow).toBe(row)
  })
  // H2: the kept native trace consumes the stopping press; only its release reaches the page.
  it.each([0, 1])('ignores passive motion after an unmatched middle-pan stop release (button %s)', button => {
    const { result, begin } = setup()
    pressRow()
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1, buttons: 4 })))
    act(() => row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1, buttons: 0 })))
    expect(result.current.context.heldMessageId).toBeNull()
    act(() => row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button, buttons: 0 })))
    mouse('mousemove', row, 130, 220)
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldRow).toBeNull()
    mouse('mousedown', row)
    expect(result.current.context.heldRow).toBe(row)
  })
  // FLM-245 H1: the kept native room pan moves one pixel before latching on release.
  it('does not acquire either row from hover after middle-button jitter', () => {
    const { result, begin } = setup()
    pressRow()
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1, buttons: 4, clientX: 100, clientY: 200 })))
    expect(result.current.context.heldMessageId).toBeNull()
    act(() => row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 4, clientX: 101, clientY: 200 })))
    act(() => row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1, buttons: 0, clientX: 101, clientY: 200 })))
    const arrival = row.cloneNode(true) as HTMLDivElement
    arrival.dataset.messageRowId = 'jitter-latched-7'
    container.append(arrival)
    mouse('mousemove', arrival, 100, 150)
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldMessageId).toBeNull()
    mouse('mousemove', row, 100, 140)
    expect(begin).toHaveBeenCalledOnce()
  })
  it('requires another press after a middle drag releases without auxclick', () => {
    const { result, begin, release } = setup()
    pressRow()
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1, buttons: 4, clientX: 100, clientY: 200 })))
    act(() => row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 4, clientX: 100, clientY: 150 })))
    act(() => row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1, buttons: 0, clientX: 100, clientY: 150 })))
    mouse('mousemove', row, 130, 160)
    expect(release).toHaveBeenCalledWith(true)
    expect(begin).toHaveBeenCalledOnce()
    expect(result.current.context.heldRow).toBeNull()
    mouse('mousedown', row)
    expect(result.current.context.heldRow).toBe(row)
  })
  it.each(['press', 'click', 'keyboard', 'menu'])('FLM-245 G2: composer input releases %s holds unless a menu is open', intent => {
    const { result, release } = setup()
    const input = document.createElement('textarea')
    input.className = 'message-input'
    document.body.append(input)
    try {
      pressRow()
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

// Drafting and reading use the same press-or-focus acquisition policy.
describe('following while drafting', () => {
  let input: HTMLTextAreaElement
  beforeEach(() => {
    container.dataset.conversationColumn = ''
    input = document.createElement('textarea')
    input.className = 'message-input'
    container.append(input)
    input.focus()
  })

  it('does not acquire an anchor from message text at the live edge', () => {
    const { begin, result } = setup()
    hoverIntoRow()
    expect(document.activeElement).toBe(input)
    expect(begin).not.toHaveBeenCalled()
    expect(result.current.context.heldRow).toBeNull()
  })

  it('leaves direct action hover passive and holds only until the press completes', () => {
    const { result, release } = setup()
    mouse('mousemove', document.body, 10, 10)
    mouse('mousemove', action)
    expect(result.current.context.heldRow).toBeNull()
    mouse('mousedown', action)
    expect(result.current.context.heldRow).toBe(row)
    mouse('mouseup', action)
    mouse('mousemove', row, 110, 210)
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.context.heldRow).toBeNull()
    expect(release).toHaveBeenCalledWith(true)
  })

  it('does not hold an invisible toolbar while the composer is active', () => {
    const { begin, result } = setup()
    container.classList.add('composer-active')
    mouse('mousemove', document.body, 10, 10)
    mouse('mousemove', action)
    expect(begin).not.toHaveBeenCalled()
    expect(result.current.context.heldRow).toBeNull()
  })

  it('retains keyboard action focus even while the composing class is present', () => {
    const { result } = setup()
    container.classList.add('composer-active')
    fireEvent.keyDown(action, { key: 'Tab' })
    act(() => action.focus())
    expect(result.current.context.heldRow).toBe(row)
  })

  it('leaves row hover passive while reading away from latest', () => {
    const { result } = setup()
    hoverIntoRow()
    expect(result.current.context.heldRow).toBeNull()
  })

  it('leaves hover passive when another column owns the editor', () => {
    const other = document.createElement('div')
    other.dataset.conversationColumn = ''
    document.body.append(other)
    other.append(input)
    try {
      input.focus()
      const { result } = setup()
      hoverIntoRow()
      expect(result.current.context.heldRow).toBeNull()
    } finally { other.remove() }
  })

  it('keeps an open menu held when the pointer returns to text', () => {
    const { result, release } = setup()
    mouse('mousemove', document.body, 10, 10)
    mouse('mousemove', action)
    act(() => result.current.context.setMenuOpen(row.dataset.messageRowId!, true, vi.fn()))
    mouse('mousemove', row, 110, 210)
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.context.heldRow).toBe(row)
    expect(release).not.toHaveBeenCalled()
  })
})
