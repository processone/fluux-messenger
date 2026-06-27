import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Users } from 'lucide-react'
import { ListEmpty } from './ListEmpty'

describe('ListEmpty', () => {
  it('renders the title (and optional icon + description)', () => {
    render(<ListEmpty icon={Users} title="No contacts yet" description="Add someone to get started" />)
    expect(screen.getByText('No contacts yet')).toBeInTheDocument()
    expect(screen.getByText('Add someone to get started')).toBeInTheDocument()
  })
  it('renders an action button that fires onClick', () => {
    const onClick = vi.fn()
    render(<ListEmpty title="No rooms yet" action={{ label: 'Create a room', onClick }} />)
    fireEvent.click(screen.getByText('Create a room'))
    expect(onClick).toHaveBeenCalledOnce()
  })
  it('renders no action button when action is omitted', () => {
    render(<ListEmpty title="Nothing here" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
