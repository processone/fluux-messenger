import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { getFloatingViewport, limitFloatingHeight } from './floatingViewport'
import { useFloatingLayerBounds } from './useFloatingLayerBounds'
import { useAnchoredMenu, type MenuDirection } from './useAnchoredMenu'
import { useContextMenu } from './useContextMenu'

function caption(height: string) {
  document.documentElement.style.setProperty('--fluux-window-titlebar-height', height)
  document.documentElement.style.fontSize = '24px'
}

afterEach(() => {
  document.documentElement.style.removeProperty('--fluux-window-titlebar-height')
  document.documentElement.style.removeProperty('font-size')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Anchored({ direction }: { direction: MenuDirection }) {
  const menu = useAnchoredMenu(true, { direction })
  return <>
    <button type="button" ref={menu.triggerRef}>Anchor</button>
    <div ref={menu.menuRef} role="menu" style={{ left: menu.position.x, top: menu.position.y }}>Actions</div>
  </>
}

function Floating() {
  const ref = useRef<HTMLDivElement>(null)
  useFloatingLayerBounds(ref)
  return <div ref={ref} role="listbox">Suggestions</div>
}

function Context() {
  const menu = useContextMenu()
  return <>
    <button type="button" onContextMenu={menu.handleContextMenu}>Context</button>
    {menu.isOpen && <div ref={menu.menuRef} role="menu" style={{ left: menu.position.x, top: menu.position.y }}>Actions</div>}
  </>
}

function box(top: number, height: number): DOMRect {
  return { x: 20, y: top, left: 20, right: 220, top, bottom: top + height, width: 200, height, toJSON() {} }
}

describe('floating viewport bounds', () => {
  it('resolves the shared rem caption at the current font size', () => {
    caption('2.5rem')
    expect(getFloatingViewport().top).toBe(60)
    document.documentElement.style.fontSize = '16px'
    expect(getFloatingViewport().top).toBe(40)
    caption('0px')
    expect(getFloatingViewport().top).toBe(0)
  })

  it('caps tall content while preserving smaller caller limits and restoring styles', () => {
    const element = document.createElement('div')
    document.body.append(element)
    element.style.maxHeight = '700px'
    element.style.overflowY = 'hidden'
    const restore = limitFloatingHeight(element, { width: 360, height: 600, top: 60 })
    expect(element.style.maxHeight).toBe('524px')
    expect(element.style.overflowY).toBe('auto')
    restore()
    expect(element.style.maxHeight).toBe('700px')
    expect(element.style.overflowY).toBe('hidden')
    element.style.maxHeight = '200px'
    const restoreSmaller = limitFloatingHeight(element, { width: 360, height: 600, top: 60 })
    expect(element.style.maxHeight).toBe('200px')
    restoreSmaller()
    element.remove()
  })

  it.each(['up', 'down'] as const)('renders a tall %s menu inside the caption bounds', (direction) => {
    caption('2.5rem')
    vi.stubGlobal('innerHeight', 600)
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(box(100, 30))
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLDivElement) {
      return box(parseFloat(this.style.top) || 0, Math.min(700, parseFloat(this.style.maxHeight) || 700))
    })
    render(<Anchored direction={direction} />)
    const menu = screen.getByRole('menu')
    expect(menu.style.top).toBe('68px')
    expect(menu.style.maxHeight).toBe('524px')
    expect(menu.getBoundingClientRect().bottom).toBe(592)
    caption('0px')
    fireEvent.resize(window)
    expect(menu.style.top).toBe('8px')
    expect(menu.style.maxHeight).toBe('')
  })

  it('renders and scrolls a tall context menu below the caption', () => {
    caption('2.5rem')
    vi.stubGlobal('innerHeight', 600)
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLDivElement) {
      return box(parseFloat(this.style.top) || 0, Math.min(700, parseFloat(this.style.maxHeight) || 700))
    })
    render(<Context />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Context' }), { clientX: 100, clientY: 300 })
    const menu = screen.getByRole('menu')
    expect(menu.getBoundingClientRect().top).toBe(68)
    expect(menu.getBoundingClientRect().bottom).toBe(592)
    fireEvent.scroll(menu)
    expect(menu).toBeInTheDocument()
  })

  it('constrains local popups and restores native-frame placement', () => {
    caption('2.5rem')
    vi.stubGlobal('innerHeight', 600)
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLDivElement) {
      const translateY = parseFloat(this.style.translate.split(' ')[1]) || 0
      return box(-40 + translateY, 300)
    })
    render(<Floating />)
    const popup = screen.getByRole('listbox')
    expect(popup.getBoundingClientRect().top).toBe(68)
    caption('0px')
    fireEvent.resize(window)
    expect(popup.getBoundingClientRect().top).toBe(-40)
    expect(popup.style.translate).toBe('')
    expect(popup.style.maxHeight).toBe('')
  })
})
