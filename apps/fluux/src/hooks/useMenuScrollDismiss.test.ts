// Intent (FLM-347): a long pointer menu scrolls inside its own height limit without closing.
import { describe, it, expect } from 'vitest'
import { scrollDismissesMenu } from './useMenuScrollDismiss'

describe('scrollDismissesMenu', () => {
  it('keeps a menu open while it scrolls itself', () => {
    const menu = document.createElement('div')
    const row = document.createElement('button')
    menu.appendChild(row)
    document.body.append(menu)
    expect(scrollDismissesMenu(menu, menu, null)).toBe(false)
    expect(scrollDismissesMenu(row, menu, null)).toBe(false)
    menu.remove()
  })

  it('still closes when the scroll moves the element the menu opened from', () => {
    const list = document.createElement('div')
    const anchor = document.createElement('div')
    const menu = document.createElement('div')
    list.appendChild(anchor)
    document.body.append(list, menu)
    expect(scrollDismissesMenu(list, menu, anchor)).toBe(true)
    list.remove(); menu.remove()
  })
})
