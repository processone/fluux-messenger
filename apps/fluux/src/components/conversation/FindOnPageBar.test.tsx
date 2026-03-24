import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FindOnPageBar } from './FindOnPageBar'

function renderBar(overrides: Partial<Parameters<typeof FindOnPageBar>[0]> = {}) {
  const props = {
    searchText: '',
    onSearchTextChange: vi.fn(),
    currentMatchIndex: 0,
    totalMatches: 0,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  const result = render(<FindOnPageBar {...props} />)
  return { ...result, props }
}

describe('FindOnPageBar', () => {
  it('renders search input', () => {
    renderBar()
    expect(screen.getByPlaceholderText(/find/i)).toBeInTheDocument()
  })

  it('auto-focuses input on mount', () => {
    renderBar()
    const input = screen.getByPlaceholderText(/find/i)
    expect(document.activeElement).toBe(input)
  })

  it('calls onSearchTextChange when typing', () => {
    const { props } = renderBar()
    const input = screen.getByPlaceholderText(/find/i)
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(props.onSearchTextChange).toHaveBeenCalledWith('hello')
  })

  it('displays match count when there are matches', () => {
    renderBar({ searchText: 'hello', currentMatchIndex: 2, totalMatches: 5 })
    expect(screen.getByText('3/5')).toBeInTheDocument()
  })

  it('displays "No matches" when query has no results', () => {
    renderBar({ searchText: 'xyz', totalMatches: 0 })
    expect(screen.getByText(/no match/i)).toBeInTheDocument()
  })

  it('does not display match info when query is too short', () => {
    renderBar({ searchText: 'x', totalMatches: 0 })
    expect(screen.queryByText(/no match/i)).not.toBeInTheDocument()
  })

  it('calls onNext on Enter', () => {
    const { props } = renderBar({ searchText: 'hello', totalMatches: 3 })
    const input = screen.getByPlaceholderText(/find/i)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onNext).toHaveBeenCalled()
  })

  it('calls onPrev on Shift+Enter', () => {
    const { props } = renderBar({ searchText: 'hello', totalMatches: 3 })
    const input = screen.getByPlaceholderText(/find/i)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(props.onPrev).toHaveBeenCalled()
  })

  it('calls onClose on Escape', () => {
    const { props } = renderBar()
    const input = screen.getByPlaceholderText(/find/i)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('calls onNext when clicking next button', () => {
    const { props } = renderBar({ searchText: 'hello', totalMatches: 3 })
    const nextBtn = screen.getByTitle(/next match/i)
    fireEvent.click(nextBtn)
    expect(props.onNext).toHaveBeenCalled()
  })

  it('calls onPrev when clicking prev button', () => {
    const { props } = renderBar({ searchText: 'hello', totalMatches: 3 })
    const prevBtn = screen.getByTitle(/previous match/i)
    fireEvent.click(prevBtn)
    expect(props.onPrev).toHaveBeenCalled()
  })

  it('disables nav buttons when no matches', () => {
    renderBar({ searchText: 'xyz', totalMatches: 0 })
    const nextBtn = screen.getByTitle(/next match/i)
    const prevBtn = screen.getByTitle(/previous match/i)
    expect(nextBtn).toBeDisabled()
    expect(prevBtn).toBeDisabled()
  })

  it('calls onClose when clicking close button', () => {
    const { props } = renderBar()
    const closeBtn = screen.getByTitle(/close/i)
    fireEvent.click(closeBtn)
    expect(props.onClose).toHaveBeenCalled()
  })
})
