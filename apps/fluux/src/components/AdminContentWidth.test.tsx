import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AdminContentWidth } from './AdminContentWidth'

describe('AdminContentWidth', () => {
  it('caps and centers its children at the shared admin content width', () => {
    render(<AdminContentWidth><p>content</p></AdminContentWidth>)
    const wrapper = screen.getByText('content').parentElement
    expect(wrapper).toHaveClass('w-full', 'max-w-2xl', 'mx-auto')
  })

  it('merges an additional className onto the same element', () => {
    render(
      <AdminContentWidth className="flex-1 flex flex-col min-h-0">
        <p>content</p>
      </AdminContentWidth>
    )
    const wrapper = screen.getByText('content').parentElement
    expect(wrapper).toHaveClass('w-full', 'max-w-2xl', 'mx-auto', 'flex-1', 'flex', 'flex-col', 'min-h-0')
  })
})
