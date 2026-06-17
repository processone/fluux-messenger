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
})
