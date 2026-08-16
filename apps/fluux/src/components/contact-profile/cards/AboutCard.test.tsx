import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { AboutCard } from './AboutCard'

describe('AboutCard', () => {
  it('renders the profile details under the About heading', () => {
    render(<AboutCard details={{ fullName: 'Sofia Almeida', org: 'ProcessOne', email: 'sofia@process-one.net', country: 'Portugal' }} />)
    expect(screen.getByText('About')).toBeInTheDocument()
    expect(screen.getByText('ProcessOne')).toBeInTheDocument()
    expect(screen.getByText('sofia@process-one.net')).toBeInTheDocument()
  })

  it('returns null when there are no details', () => {
    const { container } = render(<AboutCard details={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
