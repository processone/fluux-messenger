import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HistoryStartMarker } from './HistoryStartMarker'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'chat.historyStart': 'Beginning of conversation',
      }
      return translations[key] || key
    },
    i18n: { language: 'en-US' },
  }),
}))

describe('HistoryStartMarker', () => {
  it('should render the translated text', () => {
    render(<HistoryStartMarker />)

    expect(screen.getByText('Beginning of conversation')).toBeInTheDocument()
  })

  it('should render a single trailing rule after the label', () => {
    const { container } = render(<HistoryStartMarker />)

    const lines = container.querySelectorAll('.h-px.bg-fluux-hover')
    expect(lines).toHaveLength(1)
  })

  it('should render the label before the rule so it sits on the reading-start edge', () => {
    const { container } = render(<HistoryStartMarker />)

    const wrapper = container.firstChild as HTMLElement
    const [first, second] = Array.from(wrapper.children)
    expect(first).toHaveTextContent('Beginning of conversation')
    expect(second).toHaveClass('flex-1', 'h-px', 'bg-fluux-hover')
  })

  it('should render a clock icon', () => {
    const { container } = render(<HistoryStartMarker />)

    const icon = container.querySelector('svg')
    expect(icon).toBeInTheDocument()
    expect(icon).toHaveClass('size-3.5')
  })

  it('should have correct styling classes', () => {
    const { container } = render(<HistoryStartMarker />)

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('flex', 'items-center', 'gap-3', 'py-4', 'px-2')
  })

  it('should style the text correctly', () => {
    const { container } = render(<HistoryStartMarker />)

    const textContainer = container.querySelector('.text-xs.text-fluux-muted')
    expect(textContainer).toBeInTheDocument()
  })
})
