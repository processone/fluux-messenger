import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageSelectionBar } from './MessageSelectionBar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { num?: number }) => (o?.num !== undefined ? `${o.num} selected` : k),
  }),
}))

describe('MessageSelectionBar', () => {
  it('renders nothing when count is 0', () => {
    const { container } = render(<MessageSelectionBar count={0} onCopy={vi.fn()} onClear={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the count and fires callbacks', () => {
    const onCopy = vi.fn()
    const onClear = vi.fn()
    render(<MessageSelectionBar count={3} onCopy={onCopy} onClear={onClear} />)
    expect(screen.getByText('3 selected')).toBeTruthy()
    fireEvent.click(screen.getByText('chat.selection.copy'))
    expect(onCopy).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('chat.selection.done'))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
