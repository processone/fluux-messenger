import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Archive, User } from 'lucide-react'
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu'

const makeItems = (): OverflowMenuItem[] => [
  { key: 'profile', label: 'View profile', icon: User, onClick: vi.fn() },
  { key: 'archive', label: 'Archive', icon: Archive, onClick: vi.fn() },
]

describe('OverflowMenu', () => {
  it('renders the trigger with the given aria-label and keeps items hidden until opened', () => {
    render(<OverflowMenu ariaLabel="More actions" items={makeItems()} />)

    const trigger = screen.getByRole('button', { name: 'More actions' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('View profile')).not.toBeInTheDocument()
  })

  it('opens the menu when the trigger is clicked', () => {
    render(<OverflowMenu ariaLabel="More actions" items={makeItems()} />)

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))

    expect(screen.getByRole('button', { name: 'More actions' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('View profile')).toBeInTheDocument()
    expect(screen.getByText('Archive')).toBeInTheDocument()
  })

  it('calls the item handler and closes the menu when an item is clicked', () => {
    const items = makeItems()
    render(<OverflowMenu ariaLabel="More actions" items={items} />)

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByText('View profile'))

    expect(items[0].onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('View profile')).not.toBeInTheDocument()
  })

  it('closes the menu when Escape is pressed', () => {
    render(<OverflowMenu ariaLabel="More actions" items={makeItems()} />)

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByText('Archive')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByText('Archive')).not.toBeInTheDocument()
  })

  it('consumes Escape so it never reaches the window-level shortcut handler', () => {
    // Regression (image-scroll-position-reset follow-up): when this menu is used
    // over a conversation (e.g. contact profile actions), closing it with Escape
    // must not also fire the window shortcut that scrolls the conversation to the
    // bottom and marks it read.
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<OverflowMenu ariaLabel="More actions" items={makeItems()} />)

      fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
      expect(screen.getByText('Archive')).toBeInTheDocument()

      fireEvent.keyDown(document.body, { key: 'Escape' })

      expect(screen.queryByText('Archive')).not.toBeInTheDocument()
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('leaves Escape alone while closed (window handler still runs)', () => {
    // The listener is gated on the open state: a closed menu must not swallow
    // Escape meant for the conversation underneath.
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<OverflowMenu ariaLabel="More actions" items={makeItems()} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(windowKeydown).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('closes the menu when clicking outside', () => {
    render(
      <div>
        <span data-testid="outside">outside</span>
        <OverflowMenu ariaLabel="More actions" items={makeItems()} />
      </div>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByText('Archive')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByTestId('outside'))

    expect(screen.queryByText('Archive')).not.toBeInTheDocument()
  })

  it('does not fire the handler for a disabled item', () => {
    const onClick = vi.fn()
    render(
      <OverflowMenu
        ariaLabel="More actions"
        items={[{ key: 'x', label: 'Disabled item', icon: User, onClick, disabled: true }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const item = screen.getByText('Disabled item').closest('button') as HTMLButtonElement
    expect(item).toBeDisabled()

    fireEvent.click(item)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders nothing when there are no items', () => {
    const { container } = render(<OverflowMenu ariaLabel="More actions" items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders an active toggle item with menuitemcheckbox role and aria-checked true', () => {
    render(
      <OverflowMenu
        ariaLabel="More actions"
        items={[{ key: 'adv', label: 'Advanced mode', icon: User, onClick: vi.fn(), active: true }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const item = screen.getByRole('menuitemcheckbox', { name: 'Advanced mode' })
    expect(item).toHaveAttribute('aria-checked', 'true')
  })

  it('renders an inactive toggle item with aria-checked false', () => {
    render(
      <OverflowMenu
        ariaLabel="More actions"
        items={[{ key: 'adv', label: 'Advanced mode', icon: User, onClick: vi.fn(), active: false }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const item = screen.getByRole('menuitemcheckbox', { name: 'Advanced mode' })
    expect(item).toHaveAttribute('aria-checked', 'false')
  })

  it('renders a custom trigger instead of the kebab and toggles the menu', () => {
    render(
      <OverflowMenu
        ariaLabel="Create room"
        items={makeItems()}
        renderTrigger={({ isOpen, toggle }) => (
          <button type="button" onClick={toggle} aria-expanded={isOpen}>
            Custom trigger
          </button>
        )}
      />,
    )

    // Default kebab (named by ariaLabel) is not rendered when renderTrigger is provided.
    expect(screen.queryByRole('button', { name: 'Create room' })).not.toBeInTheDocument()

    const trigger = screen.getByRole('button', { name: 'Custom trigger' })
    expect(screen.queryByText('View profile')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.getByText('View profile')).toBeInTheDocument()
  })

  it('closes the menu via the close helper passed to a custom trigger', () => {
    render(
      <OverflowMenu
        ariaLabel="Create room"
        items={makeItems()}
        renderTrigger={({ isOpen, toggle, close }) => (
          <>
            <button type="button" onClick={toggle} aria-expanded={isOpen}>Toggle</button>
            <button type="button" onClick={close}>Close it</button>
          </>
        )}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
    expect(screen.getByText('View profile')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close it' }))
    expect(screen.queryByText('View profile')).not.toBeInTheDocument()
  })

  it('renders a separator above an item marked dividerBefore', () => {
    render(
      <OverflowMenu
        ariaLabel="More actions"
        items={[
          { key: 'a', label: 'First', icon: User, onClick: vi.fn() },
          { key: 'b', label: 'Second', icon: Archive, onClick: vi.fn(), dividerBefore: true },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })
})
