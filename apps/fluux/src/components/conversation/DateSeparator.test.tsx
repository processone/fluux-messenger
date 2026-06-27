import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DateSeparator } from './DateSeparator'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}))

// Mock formatDateHeader
vi.mock('@/utils/dateFormat', () => ({
  formatDateHeader: (date: string) => `Formatted: ${date}`,
}))

describe('DateSeparator', () => {
  it('should render the formatted date', () => {
    render(<DateSeparator date="2024-01-15" />)

    expect(screen.getByText('Formatted: 2024-01-15')).toBeInTheDocument()
  })

  it('should render a single trailing rule after the label', () => {
    const { container } = render(<DateSeparator date="2024-01-15" />)

    const lines = container.querySelectorAll('.h-px.bg-fluux-hover')
    expect(lines).toHaveLength(1)
  })

  it('should render the label before the rule so it sits on the reading-start edge', () => {
    const { container } = render(<DateSeparator date="2024-01-15" />)

    const wrapper = container.firstChild as HTMLElement
    const [first, second] = Array.from(wrapper.children)
    expect(first.tagName).toBe('SPAN')
    expect(first).toHaveTextContent('Formatted: 2024-01-15')
    expect(second).toHaveClass('flex-1', 'h-px', 'bg-fluux-hover')
  })

  it('should have correct styling classes', () => {
    const { container } = render(<DateSeparator date="2024-01-15" />)

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('flex', 'items-center', 'gap-3', 'h-12')
  })

  it('should style the date text correctly', () => {
    render(<DateSeparator date="2024-01-15" />)

    const dateText = screen.getByText('Formatted: 2024-01-15')
    expect(dateText).toHaveClass('text-xs', 'font-semibold', 'text-fluux-muted')
  })
})
