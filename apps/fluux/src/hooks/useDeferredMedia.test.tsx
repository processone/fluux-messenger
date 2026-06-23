import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MediaAutoloadProvider } from '@/contexts'
import { useDeferredMedia } from './useDeferredMedia'
import { __resetApprovedMediaUrlsForTest } from '@/utils/mediaAutoload'

function Probe({ url, isOwnMessage }: { url: string; isOwnMessage?: boolean }) {
  const { shouldLoad } = useDeferredMedia(url, isOwnMessage)
  return <span>{shouldLoad ? 'load' : 'defer'}</span>
}

describe('useDeferredMedia', () => {
  beforeEach(() => __resetApprovedMediaUrlsForTest())

  it('defers when the context auto-load is false and the message is not own', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <Probe url="https://x/a.jpg" />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('defer')).toBeInTheDocument()
  })

  it('loads own-message media even when the context auto-load is false', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <Probe url="https://x/b.jpg" isOwnMessage />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('load')).toBeInTheDocument()
  })

  it('still auto-loads non-own media when the context auto-load is true', () => {
    render(
      <MediaAutoloadProvider autoLoad>
        <Probe url="https://x/c.jpg" />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('load')).toBeInTheDocument()
  })
})
