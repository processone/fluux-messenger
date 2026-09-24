import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TouchMenu } from './TouchMenu'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }
}

describe('TouchMenu', () => {
  it('flips above an opener near the bottom and clamps to the right edge', () => {
    const anchor = document.createElement('button')
    anchor.getBoundingClientRect = () => rect(window.innerWidth - 30, window.innerHeight - 50, 20, 30)
    const measurement = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 288, 240))
    try {
      render(<TouchMenu open onClose={() => {}} anchor={anchor} ariaLabel="Actions"><button type="button">Reply</button></TouchMenu>)
      const panel = screen.getByRole('dialog')
      expect(panel.style.left).toBe(`${window.innerWidth - 12 - 288}px`)
      expect(panel.style.top).toBe(`${window.innerHeight - 50 - 8 - 240}px`)
    } finally { measurement.mockRestore() }
  })

  it('repositions above the keyboard inside the visual viewport', () => {
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 700, offsetLeft: 0, offsetTop: 0 })
    vi.stubGlobal('visualViewport', viewport)
    const anchor = document.createElement('button')
    anchor.getBoundingClientRect = () => rect(40, 400, 40, 30)
    const measurement = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 288, 200))
    try {
      render(<TouchMenu open onClose={() => {}} anchor={anchor} ariaLabel="Actions"><button type="button">Reply</button></TouchMenu>)
      const panel = screen.getByRole('dialog')
      expect(panel.style.top).toBe('438px')
      viewport.height = 300
      viewport.dispatchEvent(new Event('resize'))
      expect(panel.style.top).toBe('88px')
      expect(panel.style.maxHeight).toBe('276px')
    } finally { measurement.mockRestore(); vi.unstubAllGlobals() }
  })

  it('traps focus, dismisses on Escape and restores the opener', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const onClose = vi.fn()
    const { unmount } = render(<TouchMenu open onClose={onClose} anchor={opener} ariaLabel="Actions"><button type="button">Reply</button><button type="button">Copy</button></TouchMenu>)
    expect(document.activeElement).toBe(screen.getByText('Reply'))
    screen.getByText('Copy').focus()
    fireEvent.keyDown(screen.getByText('Copy'), { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('Reply'))
    fireEvent.keyDown(screen.getByText('Reply'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('dismisses on an outside tap without activating underlying content', () => {
    const onClose = vi.fn()
    const onClick = vi.fn()
    render(<div onClick={onClick}><TouchMenu open onClose={onClose} ariaLabel="Actions"><button type="button">Reply</button></TouchMenu></div>)
    fireEvent.click(document.querySelector('[data-modal] > [aria-hidden]')!)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClick).not.toHaveBeenCalled()
  })
})
