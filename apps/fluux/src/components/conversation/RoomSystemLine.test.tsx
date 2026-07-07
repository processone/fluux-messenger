import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RoomSystemLine } from './RoomSystemLine'

describe('RoomSystemLine', () => {
  it('renders a localized nick-change notice', () => {
    render(<RoomSystemLine event={{ kind: 'nick-changed', oldNick: 'alice', newNick: 'alice2' }} />)
    expect(screen.getByText('alice is now known as alice2')).toBeInTheDocument()
  })

  it('renders nothing for an unknown event kind', () => {
    // @ts-expect-error — exercising the defensive default branch
    const { container } = render(<RoomSystemLine event={{ kind: 'unknown' }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
