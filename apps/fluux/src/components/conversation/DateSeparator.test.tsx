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

  it('should draw the label as a centered pill with no rules', () => {
    const { container } = render(<DateSeparator date="2024-01-15" />)

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('flex', 'justify-center', 'pt-5', 'pb-0.5')
    expect(wrapper.children).toHaveLength(1)
    expect(container.querySelectorAll('.h-px')).toHaveLength(0)
    expect(wrapper.firstElementChild).toHaveClass('rounded-full', 'border', 'bg-fluux-chat')
  })

  it('should style the date text correctly', () => {
    render(<DateSeparator date="2024-01-15" />)

    const dateText = screen.getByText('Formatted: 2024-01-15')
    expect(dateText).toHaveClass('text-xs', 'font-semibold', 'text-fluux-muted')
  })
})
