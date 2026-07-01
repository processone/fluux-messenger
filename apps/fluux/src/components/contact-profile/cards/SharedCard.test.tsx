import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SharedCard } from './SharedCard'

describe('SharedCard', () => {
  it('renders a pill per group', () => {
    render(<SharedCard groups={['Team', 'XMPP']} isInRoster={true} />)
    expect(screen.getByText('Shared')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.getByText('XMPP')).toBeInTheDocument()
  })

  it('returns null for a non-roster contact', () => {
    const { container } = render(<SharedCard groups={['Team']} isInRoster={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('returns null when there are no groups', () => {
    const { container } = render(<SharedCard groups={[]} isInRoster={true} />)
    expect(container).toBeEmptyDOMElement()
  })
})
