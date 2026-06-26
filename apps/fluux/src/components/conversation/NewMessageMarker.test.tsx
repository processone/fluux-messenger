import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NewMessageMarker } from './NewMessageMarker'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'chat.newMessages') return 'New Messages'
      return key
    },
  }),
}))

describe('NewMessageMarker', () => {
  it('should render the "New Messages" text', () => {
    render(<NewMessageMarker />)

    expect(screen.getByText('New Messages')).toBeInTheDocument()
  })

  it('should render red horizontal lines', () => {
    const { container } = render(<NewMessageMarker />)

    const lines = container.querySelectorAll('.h-px.bg-fluux-red')
    expect(lines).toHaveLength(2)
  })

  it('should have correct styling classes', () => {
    const { container } = render(<NewMessageMarker />)

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('flex', 'items-center', 'gap-4', 'h-12')
  })

  it('should style the text in red', () => {
    render(<NewMessageMarker />)

    const text = screen.getByText('New Messages')
    expect(text).toHaveClass('text-xs', 'font-semibold', 'text-fluux-error')
  })
})
