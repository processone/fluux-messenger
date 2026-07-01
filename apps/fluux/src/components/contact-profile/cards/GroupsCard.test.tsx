import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { GroupsCard } from './GroupsCard'

describe('GroupsCard', () => {
  it('renders a pill per group', () => {
    render(<GroupsCard groups={['Team', 'XMPP']} isInRoster={true} />)
    expect(screen.getByText('Groups')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.getByText('XMPP')).toBeInTheDocument()
  })

  it('returns null for a non-roster contact', () => {
    const { container } = render(<GroupsCard groups={['Team']} isInRoster={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('returns null when there are no groups', () => {
    const { container } = render(<GroupsCard groups={[]} isInRoster={true} />)
    expect(container).toBeEmptyDOMElement()
  })
})
