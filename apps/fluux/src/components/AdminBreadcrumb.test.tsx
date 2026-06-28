import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AdminBreadcrumb } from './AdminBreadcrumb'

describe('AdminBreadcrumb', () => {
  it('renders all crumb labels', () => {
    render(
      <AdminBreadcrumb
        crumbs={[
          { label: 'Admin', onClick: vi.fn() },
          { label: 'Users', onClick: vi.fn() },
          { label: 'alice@example.com' },
        ]}
      />
    )
    expect(screen.getByText('Admin')).toBeInTheDocument()
    expect(screen.getByText('Users')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
  })

  it('fires onClick when a non-last crumb is clicked', () => {
    const onClick = vi.fn()
    render(
      <AdminBreadcrumb
        crumbs={[
          { label: 'Admin', onClick },
          { label: 'Users' },
        ]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Admin' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('renders the last crumb as non-clickable (no button)', () => {
    render(
      <AdminBreadcrumb
        crumbs={[
          { label: 'Admin', onClick: vi.fn() },
          { label: 'Users', onClick: vi.fn() },
        ]}
      />
    )
    // Only the first (non-last) crumb should be a button.
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveTextContent('Admin')
  })

  it('renders a single-crumb trail without any button', () => {
    render(<AdminBreadcrumb crumbs={[{ label: 'Admin' }]} />)
    expect(screen.getByText('Admin')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
