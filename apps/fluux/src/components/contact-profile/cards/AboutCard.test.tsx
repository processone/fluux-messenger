import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { AboutCard } from './AboutCard'

describe('AboutCard', () => {
  it('renders vCard fields under the About heading', () => {
    render(<AboutCard vcard={{ fullName: 'Sofia Almeida', org: 'ProcessOne', email: 'sofia@process-one.net', country: 'Portugal' }} />)
    expect(screen.getByText('About')).toBeInTheDocument()
    expect(screen.getByText('ProcessOne')).toBeInTheDocument()
    expect(screen.getByText('sofia@process-one.net')).toBeInTheDocument()
  })

  it('returns null when the vCard is empty', () => {
    const { container } = render(<AboutCard vcard={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
