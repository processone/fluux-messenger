import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MediaAutoloadProvider, useMediaAutoload } from './MediaAutoloadContext'

function Probe() {
  return <span>{useMediaAutoload() ? 'auto' : 'defer'}</span>
}

describe('MediaAutoloadContext', () => {
  it('defaults to auto-load (true) with no provider', () => {
    render(<Probe />)
    expect(screen.getByText('auto')).toBeInTheDocument()
  })

  it('uses the provider value when wrapped', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <Probe />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('defer')).toBeInTheDocument()
  })
})
