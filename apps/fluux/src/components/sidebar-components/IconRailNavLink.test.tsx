import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useEffect, type ReactNode } from 'react'
import { IconRailNavLink } from './IconRailNavLink'
import { MessageCircle, Hash } from 'lucide-react'

// Track location to verify active state is derived from URL
const currentLocation = { current: { pathname: '/' } }

function LocationTracker() {
  const location = useLocation()
  useEffect(() => {
    currentLocation.current = { pathname: location.pathname }
  })
  return null
}

// Router wrapper for testing
function createWrapper(initialPath = '/') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationTracker />
        {children}
      </MemoryRouter>
    )
  }
}

describe('IconRailNavLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentLocation.current = { pathname: '/' }
  })

  describe('rendering', () => {
    it('should render with icon and button', () => {
      const Wrapper = createWrapper('/rooms')
      render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={vi.fn()}
        />,
        { wrapper: Wrapper }
      )

      expect(screen.getByRole('button')).toBeInTheDocument()
    })

    it('should show tooltip on hover', async () => {
      vi.useFakeTimers()
      const Wrapper = createWrapper('/rooms')
      render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={vi.fn()}
        />,
        { wrapper: Wrapper }
      )

      // Tooltip appears after hover delay (500ms)
      const button = screen.getByRole('button')
      fireEvent.mouseEnter(button.parentElement!)

      // Fast-forward through tooltip delay (wrapped in act for state update)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      // Tooltip should now be visible via portal
      expect(screen.getByRole('tooltip')).toHaveTextContent('Messages')

      vi.useRealTimers()
    })

    it('should render badge when showBadge is true', () => {
      const Wrapper = createWrapper('/')
      const { container } = render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={vi.fn()}
          showBadge={true}
        />,
        { wrapper: Wrapper }
      )

      // Badge should be visible (small red dot)
      const badge = container.querySelector('.bg-fluux-red')
      expect(badge).toBeInTheDocument()
    })

    it('should not render badge when showBadge is false', () => {
      const Wrapper = createWrapper('/')
      const { container } = render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={vi.fn()}
          showBadge={false}
        />,
        { wrapper: Wrapper }
      )

      const badge = container.querySelector('.bg-fluux-red')
      expect(badge).not.toBeInTheDocument()
    })
  })

  describe('active state from URL', () => {
    it('should be active when URL matches pathPrefix exactly', () => {
      const Wrapper = createWrapper('/messages')
      render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={vi.fn()}
        />,
        { wrapper: Wrapper }
      )

      const button = screen.getByRole('button')
      expect(button).toHaveClass('bg-fluux-brand')
    })

    it('should be active when URL starts with pathPrefix + /', () => {
      const Wrapper = createWrapper('/messages/user@example.com')
      render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={vi.fn()}
        />,
        { wrapper: Wrapper }
      )

      const button = screen.getByRole('button')
      expect(button).toHaveClass('bg-fluux-brand')
    })

    it('should not be active when URL does not match', () => {
      const Wrapper = createWrapper('/rooms')
      render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={vi.fn()}
        />,
        { wrapper: Wrapper }
      )

      const button = screen.getByRole('button')
      expect(button).not.toHaveClass('bg-fluux-brand')
      expect(button).toHaveClass('text-fluux-muted')
    })

    it('should not be active for partial prefix match (e.g., /messagesExtra)', () => {
      const Wrapper = createWrapper('/messagesExtra')
      render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={vi.fn()}
        />,
        { wrapper: Wrapper }
      )

      const button = screen.getByRole('button')
      expect(button).not.toHaveClass('bg-fluux-brand')
    })
  })

  describe('navigation via onClick', () => {
    it('should call onNavigate with view when clicked', () => {
      const onNavigate = vi.fn()
      const Wrapper = createWrapper('/rooms')
      render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={onNavigate}
        />,
        { wrapper: Wrapper }
      )

      fireEvent.click(screen.getByRole('button'))
      expect(onNavigate).toHaveBeenCalledWith('messages')
      expect(onNavigate).toHaveBeenCalledTimes(1)
    })

    it('should call onNavigate even when already active', () => {
      const onNavigate = vi.fn()
      const Wrapper = createWrapper('/messages')
      render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={onNavigate}
        />,
        { wrapper: Wrapper }
      )

      fireEvent.click(screen.getByRole('button'))
      expect(onNavigate).toHaveBeenCalledWith('messages')
    })

    it('should pass correct view for different views', () => {
      const onNavigate = vi.fn()
      const Wrapper = createWrapper('/')

      render(
        <IconRailNavLink
          icon={Hash}
          label="Rooms"
          view="rooms"
          pathPrefix="/rooms"
          onNavigate={onNavigate}
        />,
        { wrapper: Wrapper }
      )

      fireEvent.click(screen.getByRole('button'))
      expect(onNavigate).toHaveBeenCalledWith('rooms')
    })
  })

  describe('URL is not modified directly', () => {
    it('should NOT navigate via router - only calls onNavigate callback', () => {
      const onNavigate = vi.fn()
      const Wrapper = createWrapper('/rooms')
      render(
        <IconRailNavLink
          icon={MessageCircle}
          label="Messages"
          view="messages"
          pathPrefix="/messages"
          onNavigate={onNavigate}
        />,
        { wrapper: Wrapper }
      )

      // Location before click
      expect(currentLocation.current.pathname).toBe('/rooms')

      fireEvent.click(screen.getByRole('button'))

      // Location should NOT change - we're using onClick, not NavLink
      // The parent component handles actual navigation
      expect(currentLocation.current.pathname).toBe('/rooms')

      // But onNavigate should have been called
      expect(onNavigate).toHaveBeenCalledWith('messages')
    })
  })
})
