import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

  // Captain's ask: a date bubble opens jump to date on its day.
  it('is a keyboard-reachable button opening jump to date when given onSelect', () => {
    const onSelect = vi.fn()
    render(<DateSeparator date="2024-01-15" onSelect={onSelect} />)

    const pill = screen.getByRole('button', { name: 'chat.jumpToDate.fromPill' })
    expect(pill.tagName).toBe('BUTTON')
    expect(pill).toHaveAttribute('aria-haspopup', 'dialog')
    expect(pill.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(pill).toHaveTextContent('Formatted: 2024-01-15')
    fireEvent.click(pill)
    expect(onSelect).toHaveBeenCalledWith('2024-01-15')
    expect(pill).toHaveFocus()
  })

  // Native activation must not become the timeline's message-selection shortcut.
  it.each(['Enter', ' '])('keeps %s activation inside the day pill', (key) => {
    const timelineKey = vi.fn()
    render(<div onKeyDown={timelineKey}><DateSeparator date="2024-01-15" onSelect={() => {}} /></div>)
    const pill = screen.getByRole('button', { name: 'chat.jumpToDate.fromPill' })
    fireEvent.keyDown(pill, { key })
    expect(timelineKey).not.toHaveBeenCalled()
    fireEvent.keyDown(pill, { key: 'Escape' })
    expect(timelineKey).toHaveBeenCalledOnce()
  })

  it('stays plain text without onSelect', () => {
    render(<DateSeparator date="2024-01-15" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
