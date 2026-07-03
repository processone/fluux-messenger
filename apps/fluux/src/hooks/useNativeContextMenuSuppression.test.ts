import { describe, it, expect, afterEach } from 'vitest'
import { shouldSuppressNativeMenu } from './useNativeContextMenuSuppression'

/** Build a minimal Selection-like object over the contents of `node`. */
function selectionOver(node: Node, text = 'selected'): Selection {
  const range = document.createRange()
  range.selectNodeContents(node)
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
  } as unknown as Selection
}

describe('shouldSuppressNativeMenu', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('suppresses on a plain element', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(shouldSuppressNativeMenu(div, null, false)).toBe(true)
  })

  it('suppresses when target is not an element', () => {
    expect(shouldSuppressNativeMenu(null, null, false)).toBe(true)
    expect(shouldSuppressNativeMenu(new EventTarget(), null, false)).toBe(true)
  })

  it('allows on an input', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(shouldSuppressNativeMenu(input, null, false)).toBe(false)
  })

  it('allows on a textarea', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    expect(shouldSuppressNativeMenu(ta, null, false)).toBe(false)
  })

  it('allows inside contenteditable="true"', () => {
    const ce = document.createElement('div')
    ce.setAttribute('contenteditable', 'true')
    const span = document.createElement('span')
    span.textContent = 'hi'
    ce.appendChild(span)
    document.body.appendChild(ce)
    expect(shouldSuppressNativeMenu(span, null, false)).toBe(false)
  })

  it('suppresses inside contenteditable="false"', () => {
    const ce = document.createElement('div')
    ce.setAttribute('contenteditable', 'false')
    const span = document.createElement('span')
    span.textContent = 'hi'
    ce.appendChild(span)
    document.body.appendChild(ce)
    expect(shouldSuppressNativeMenu(span, null, false)).toBe(true)
  })

  it('allows when a non-collapsed selection intersects the target', () => {
    const p = document.createElement('p')
    p.textContent = 'some words'
    document.body.appendChild(p)
    expect(shouldSuppressNativeMenu(p, selectionOver(p), false)).toBe(false)
  })

  it('suppresses when the selection is collapsed', () => {
    const p = document.createElement('p')
    p.textContent = 'some words'
    document.body.appendChild(p)
    const collapsed = { isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => document.createRange() } as unknown as Selection
    expect(shouldSuppressNativeMenu(p, collapsed, false)).toBe(true)
  })

  it('suppresses when the selection is empty whitespace', () => {
    const p = document.createElement('p')
    p.textContent = 'some words'
    document.body.appendChild(p)
    expect(shouldSuppressNativeMenu(p, selectionOver(p, '   '), false)).toBe(true)
  })

  it('does not suppress when the event was already handled (defaultPrevented)', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(shouldSuppressNativeMenu(div, null, true)).toBe(false)
  })
})
