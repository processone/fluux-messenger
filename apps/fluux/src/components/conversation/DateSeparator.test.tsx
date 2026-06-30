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

  it('should flank the label with a rule on each side', () => {
    const { container } = render(<DateSeparator date="2024-01-15" />)

    const lines = container.querySelectorAll('.h-px.bg-fluux-hover')
    expect(lines).toHaveLength(2)
  })

  it('should center the label between two symmetric rules', () => {
    const { container } = render(<DateSeparator date="2024-01-15" />)

    const wrapper = container.firstChild as HTMLElement
    const [first, second, third] = Array.from(wrapper.children)
    expect(first).toHaveClass('flex-1', 'h-px', 'bg-fluux-hover')
    expect(second.tagName).toBe('SPAN')
    expect(second).toHaveTextContent('Formatted: 2024-01-15')
    expect(third).toHaveClass('flex-1', 'h-px', 'bg-fluux-hover')
  })

  it('should have correct styling classes', () => {
    const { container } = render(<DateSeparator date="2024-01-15" />)

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('flex', 'items-center', 'gap-3', 'pt-6', 'pb-2')
  })

  it('should style the date text correctly', () => {
    render(<DateSeparator date="2024-01-15" />)

    const dateText = screen.getByText('Formatted: 2024-01-15')
    expect(dateText).toHaveClass('text-xs', 'font-semibold', 'text-fluux-muted')
  })
})
