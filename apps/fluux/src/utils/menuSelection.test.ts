import { describe, it, expect, beforeEach } from 'vitest'
import { selectionAtButtonDown, selectionForMenu } from './menuSelection'

describe('menu selection', () => {
  let box: HTMLElement
  beforeEach(() => {
    document.body.innerHTML = '<div id="box">Alice Smith</div><p id="other">elsewhere</p>'
    box = document.getElementById('box')!
    window.getSelection()?.removeAllRanges()
  })
  const select = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r) }

  it('reads the selection only for a right-click or Control-click', () => {
    select(box)
    expect(selectionAtButtonDown({ button: 2, ctrlKey: false })).toBe('Alice Smith')
    expect(selectionAtButtonDown({ button: 0, ctrlKey: true })).toBe('Alice Smith')
    expect(selectionAtButtonDown({ button: 0, ctrlKey: false })).toBeNull()
  })
  it('keeps words that were selected before the click', () => {
    select(box)
    expect(selectionForMenu(box, 'Alice Smith').text).toBe('Alice Smith')
  })
  it('clears a word that only the click selected', () => {
    select(box)
    expect(selectionForMenu(box, '').text).toBe('')
    expect(window.getSelection()!.toString()).toBe('')
  })
  it('ignores a selection outside the container', () => {
    select(document.getElementById('other')!)
    expect(selectionForMenu(box, 'elsewhere').text).toBe('')
  })
})
