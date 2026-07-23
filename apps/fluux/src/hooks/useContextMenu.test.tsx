import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useContextMenu } from './useContextMenu'

function TestComponent({ longPressDuration = 500 }: { longPressDuration?: number } = {}) {
  const menu = useContextMenu({ longPressDuration })

  return (
    <div>
      <div
        data-testid="trigger"
        onContextMenu={menu.handleContextMenu}
        onTouchStart={menu.handleTouchStart}
        onTouchEnd={menu.handleTouchEnd}
        onTouchMove={menu.handleTouchEnd}
      >
        Right-click or long-press me
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
