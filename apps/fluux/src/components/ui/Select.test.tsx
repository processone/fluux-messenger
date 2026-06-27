import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Select } from './Select'

describe('Select', () => {
  it('renders options and fires onChange', () => {
    const onChange = vi.fn()
    render(<Select value="a" onChange={onChange}><option value="a">A</option><option value="b">B</option></Select>)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    expect(onChange).toHaveBeenCalled()
  })
})
