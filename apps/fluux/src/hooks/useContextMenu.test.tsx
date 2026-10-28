import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { useContextMenu } from './useContextMenu'
import { useCloseOnEscape } from './useCloseOnEscape'
const haptic = vi.hoisted(() => vi.fn())
vi.mock('@/platform/ios/haptics', () => ({ iosHaptic: haptic }))

function TestComponent({ longPressDuration = 500 }: { longPressDuration?: number } = {}) {
  const menu = useContextMenu({ longPressDuration })

  return (
    <div>
      <div data-testid="trigger-list">
        <div
          data-testid="trigger"
          onContextMenu={menu.handleContextMenu}
          onTouchStart={menu.handleTouchStart}
          onTouchEnd={menu.handleTouchEnd}
          onTouchMove={menu.handleTouchEnd}
          onTouchCancel={menu.handleTouchEnd}
        >
          Right-click or long-press me
        </div>
      </div>

      {menu.isOpen && (
        <div
          ref={menu.menuRef}
          data-testid="menu"
          style={{ left: menu.position.x, top: menu.position.y }}
        >
          <button type="button" data-testid="menu-item" onClick={menu.close}>
            Close
          </button>
        </div>
      )}

      <div data-testid="outside">Outside</div>
      <div data-testid="is-open">{menu.isOpen ? 'open' : 'closed'}</div>
      <div data-testid="position-x">{menu.position.x}</div>
      <div data-testid="position-y">{menu.position.y}</div>
    </div>
  )
}

describe('useContextMenu', () => {
  beforeEach(() => {
    haptic.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('right-click (desktop)', () => {
    it('should open menu on right-click', () => {
      render(<TestComponent />)

      expect(screen.getByTestId('is-open').textContent).toBe('closed')

      fireEvent.contextMenu(screen.getByTestId('trigger'), {
        clientX: 100,
        clientY: 200,
      })

      expect(screen.getByTestId('is-open').textContent).toBe('open')
      expect(screen.getByTestId('menu')).toBeDefined()
    })

    it('should set position from right-click coordinates', () => {
      render(<TestComponent />)

      fireEvent.contextMenu(screen.getByTestId('trigger'), {
        clientX: 150,
        clientY: 250,
      })

      expect(screen.getByTestId('position-x').textContent).toBe('150')
      expect(screen.getByTestId('position-y').textContent).toBe('250')
    })

    it('should prevent default on right-click', () => {
      render(<TestComponent />)

      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 200,
      })
      const preventDefault = vi.spyOn(event, 'preventDefault')

      act(() => {
        screen.getByTestId('trigger').dispatchEvent(event)
      })

      expect(preventDefault).toHaveBeenCalled()
    })
  })

  describe('long-press (mobile)', () => {
    it('should open menu after long press duration', () => {
      render(<TestComponent longPressDuration={500} />)

      expect(screen.getByTestId('is-open').textContent).toBe('closed')

      fireEvent.touchStart(screen.getByTestId('trigger'), {
        touches: [{ clientX: 100, clientY: 200 }],
      })

      // Before timeout
      act(() => {
        vi.advanceTimersByTime(499)
      })
      expect(screen.getByTestId('is-open').textContent).toBe('closed')

      // After timeout
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(screen.getByTestId('is-open').textContent).toBe('open')
      expect(haptic).toHaveBeenCalledWith('contextMenu')
    })

    it('should set position from touch coordinates', () => {
      render(<TestComponent />)

      fireEvent.touchStart(screen.getByTestId('trigger'), {
        touches: [{ clientX: 175, clientY: 275 }],
      })

      act(() => {
        vi.advanceTimersByTime(500)
      })

      expect(screen.getByTestId('position-x').textContent).toBe('175')
      expect(screen.getByTestId('position-y').textContent).toBe('275')
    })

    it.each(['touchMove', 'touchCancel', 'touchEnd'] as const)('does not confirm a hold cancelled by %s', event => {
      render(<TestComponent />)
      const trigger = screen.getByTestId('trigger')
      fireEvent.touchStart(trigger, { touches: [{ clientX: 100, clientY: 200 }] })
      act(() => vi.advanceTimersByTime(300))
      fireEvent[event](trigger)
      act(() => vi.advanceTimersByTime(500))
      expect(haptic).not.toHaveBeenCalled()
      expect(screen.getByTestId('is-open').textContent).toBe('closed')
    })

    it('does not confirm an unmounted hold', () => {
      const { unmount } = render(<TestComponent />)
      fireEvent.touchStart(screen.getByTestId('trigger'), { touches: [{ clientX: 100, clientY: 200 }] })
      unmount()
      act(() => vi.advanceTimersByTime(500))
      expect(haptic).not.toHaveBeenCalled()
    })

    it('should cancel long press on touch end', () => {
      render(<TestComponent longPressDuration={500} />)

      fireEvent.touchStart(screen.getByTestId('trigger'), {
        touches: [{ clientX: 100, clientY: 200 }],
      })

      act(() => {
        vi.advanceTimersByTime(300)
      })

      fireEvent.touchEnd(screen.getByTestId('trigger'))

      act(() => {
        vi.advanceTimersByTime(200)
      })

      expect(screen.getByTestId('is-open').textContent).toBe('closed')
    })

    it('should cancel long press on touch move', () => {
      render(<TestComponent longPressDuration={500} />)

      fireEvent.touchStart(screen.getByTestId('trigger'), {
        touches: [{ clientX: 100, clientY: 200 }],
      })

      act(() => {
        vi.advanceTimersByTime(300)
      })

      fireEvent.touchMove(screen.getByTestId('trigger'))

      act(() => {
        vi.advanceTimersByTime(200)
      })

      expect(screen.getByTestId('is-open').textContent).toBe('closed')
    })

    it('should use custom long press duration', () => {
      render(<TestComponent longPressDuration={200} />)

      fireEvent.touchStart(screen.getByTestId('trigger'), {
        touches: [{ clientX: 100, clientY: 200 }],
      })

      act(() => {
        vi.advanceTimersByTime(199)
      })
      expect(screen.getByTestId('is-open').textContent).toBe('closed')

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(screen.getByTestId('is-open').textContent).toBe('open')
    })
  })

  describe('close behavior', () => {
    it('should close menu when close() is called', () => {
      render(<TestComponent />)

      // Open menu
      fireEvent.contextMenu(screen.getByTestId('trigger'), {
        clientX: 100,
        clientY: 200,
      })
      expect(screen.getByTestId('is-open').textContent).toBe('open')

      // Click close button
      fireEvent.click(screen.getByTestId('menu-item'))
      expect(screen.getByTestId('is-open').textContent).toBe('closed')
    })

    it('should close menu when clicking outside', () => {
      render(<TestComponent />)

      // Open menu
      fireEvent.contextMenu(screen.getByTestId('trigger'), {
        clientX: 100,
        clientY: 200,
      })
      expect(screen.getByTestId('is-open').textContent).toBe('open')

      // Click outside
      fireEvent.mouseDown(screen.getByTestId('outside'))
      expect(screen.getByTestId('is-open').textContent).toBe('closed')
    })

    it('should not close menu when clicking inside menu', () => {
      render(<TestComponent />)

      // Open menu
      fireEvent.contextMenu(screen.getByTestId('trigger'), {
        clientX: 100,
        clientY: 200,
      })
      expect(screen.getByTestId('is-open').textContent).toBe('open')

      // Click inside menu (but not on close button)
      fireEvent.mouseDown(screen.getByTestId('menu'))
      expect(screen.getByTestId('is-open').textContent).toBe('open')
    })
  })
})

describe('scrolling inside a context menu', () => {
  afterEach(() => document.documentElement.style.removeProperty('--fluux-window-titlebar-height'))

  it('keeps the menu open for its own scrolling and closes when its list scrolls', () => {
    document.documentElement.style.setProperty('--fluux-window-titlebar-height', '60px')
    render(<TestComponent />)
    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 100, clientY: 100 })
    fireEvent.scroll(screen.getByTestId('menu'))
    expect(screen.getByTestId('menu')).toBeInTheDocument()
    fireEvent.scroll(screen.getByTestId('trigger-list'))
    expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
  })

  it('preserves dismissal on scroll with a native frame', () => {
    render(<TestComponent />)
    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 100, clientY: 100 })
    fireEvent.scroll(screen.getByTestId('menu'))
    expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
  })
})

// The desktop Whisper journeys lost the member menu when the room's message list re-pinned
// itself just after the menu opened. Only a scroll that moves the menu's anchor closes it.
describe('scrolling elsewhere while a context menu is open', () => {
  it('stays open while an unrelated list scrolls and closes when the page scrolls', () => {
    render(<TestComponent />)
    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 100, clientY: 100 })
    fireEvent.scroll(screen.getByTestId('outside'))
    expect(screen.getByTestId('menu')).toBeInTheDocument()
    fireEvent.scroll(document)
    expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
  })

  it('keeps the long-pressed element as the anchor', () => {
    vi.useFakeTimers()
    try {
      render(<TestComponent />)
      fireEvent.touchStart(screen.getByTestId('trigger'), { touches: [{ clientX: 100, clientY: 100 }] })
      act(() => vi.advanceTimersByTime(500))
      fireEvent.touchEnd(screen.getByTestId('trigger'))
      fireEvent.scroll(screen.getByTestId('outside'))
      expect(screen.getByTestId('menu')).toBeInTheDocument()
      fireEvent.scroll(screen.getByTestId('trigger-list'))
      expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

// The captain's ruling on review R1: "Escape closes the menu first". The conversation's own
// Escape (mark read and jump to the newest message) listens on window and must not also run.
describe('Escape while a context menu is open', () => {
  it('closes only the menu, and reaches the conversation once no menu is open', () => {
    const conversationEscape = vi.fn()
    const onWindowKey = (e: KeyboardEvent) => { if (e.key === 'Escape') conversationEscape() }
    window.addEventListener('keydown', onWindowKey)
    try {
      render(<TestComponent />)
      fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 100, clientY: 100 })
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
      expect(conversationEscape).not.toHaveBeenCalled()
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(conversationEscape).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })
})

// The captain's ruling on review R3: with stacked overlays, Escape closes only the one on top.
function Modal({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useCloseOnEscape(onClose, true, ref)
  return <div ref={ref} data-modal="true">{children}</div>
}

describe('Escape with a context menu and another overlay stacked', () => {
  it('closes a menu opened in a lightbox and leaves the lightbox open', () => {
    const closeLightbox = vi.fn()
    render(<Modal onClose={closeLightbox}><TestComponent /></Modal>)
    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 100, clientY: 100 })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
    expect(closeLightbox).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeLightbox).toHaveBeenCalledTimes(1)
  })

  it('closes shortcut help opened over a menu and leaves the menu open', () => {
    const closeHelp = vi.fn()
    const Page = ({ help }: { help: boolean }) => <><TestComponent />{help && <Modal onClose={closeHelp} />}</>
    const { rerender } = render(<Page help={false} />)
    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 100, clientY: 100 })
    rerender(<Page help />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeHelp).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('menu')).toBeInTheDocument()
    rerender(<Page help={false} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
  })
})
