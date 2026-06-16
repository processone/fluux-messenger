import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { LinkPreviewCard, IMAGE_RETRY_DELAY_MS } from './LinkPreviewCard'
import type { LinkPreview } from '@fluux/sdk'

const preview: LinkPreview = {
  url: 'https://github.com/processone/fluux-messenger/pull/493',
  title: 'Some pull request',
  image: 'https://opengraph.githubassets.com/abc/processone/fluux-messenger/pull/493',
}

describe('LinkPreviewCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the preview image', () => {
    const { container } = render(<LinkPreviewCard preview={preview} />)
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('retries the image after a transient load error instead of hiding it', () => {
    const { container } = render(<LinkPreviewCard preview={preview} />)

    // Transient failure (e.g. a rate-limited revalidation): the image element
    // is removed while waiting...
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()

    // ...then re-mounted after the retry delay so the browser re-requests it.
    act(() => {
      vi.advanceTimersByTime(IMAGE_RETRY_DELAY_MS)
    })
    const retried = container.querySelector('img')
    expect(retried).not.toBeNull()
    expect(retried).toHaveAttribute('src', preview.image)
  })

  it('hides the image after the retry also fails', () => {
    const { container } = render(<LinkPreviewCard preview={preview} />)

    fireEvent.error(container.querySelector('img')!)
    act(() => {
      vi.advanceTimersByTime(IMAGE_RETRY_DELAY_MS)
    })
    fireEvent.error(container.querySelector('img')!)

    act(() => {
      vi.advanceTimersByTime(IMAGE_RETRY_DELAY_MS * 10)
    })
    expect(container.querySelector('img')).toBeNull()
  })

  it('still renders title and description while the image is gone', () => {
    const { container, getByText } = render(<LinkPreviewCard preview={preview} />)

    fireEvent.error(container.querySelector('img')!)
    act(() => {
      vi.advanceTimersByTime(IMAGE_RETRY_DELAY_MS)
    })
    fireEvent.error(container.querySelector('img')!)

    expect(getByText('Some pull request')).toBeInTheDocument()
  })

  it('shows the image again when the preview image URL changes after one was hidden', () => {
    const previewA: LinkPreview = { ...preview, image: 'https://host/a.png' }
    const previewB: LinkPreview = { ...preview, image: 'https://host/b.png' }
    const { container, rerender } = render(<LinkPreviewCard preview={previewA} />)

    // Exhaust retries for image A → hidden ('gone').
    fireEvent.error(container.querySelector('img')!)
    act(() => {
      vi.advanceTimersByTime(IMAGE_RETRY_DELAY_MS)
    })
    fireEvent.error(container.querySelector('img')!)
    act(() => {
      vi.advanceTimersByTime(IMAGE_RETRY_DELAY_MS * 10)
    })
    expect(container.querySelector('img')).toBeNull()

    // The instance is reused (React reconciliation) for a preview with a new
    // image — the stale 'gone'/spent-attempt state must reset so the new, valid
    // image shows.
    rerender(<LinkPreviewCard preview={previewB} />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', previewB.image)
  })
})
