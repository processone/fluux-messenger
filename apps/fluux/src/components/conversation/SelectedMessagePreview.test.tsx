import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SelectedMessagePreview } from './SelectedMessagePreview'

describe('SelectedMessagePreview', () => {
  it('preserves rich content without duplicating controls or changing the original', () => {
    const source = document.createElement('div')
    source.innerHTML = '<strong id="message-label">Selected text</strong><img src="photo.png" alt="Photo"><button data-message-action-trigger>More</button><a href="https://example.com">Link</a>'
    document.body.append(source)
    const { container, unmount } = render(<SelectedMessagePreview source={source} body="Selected text" />)
    const snapshot = container.querySelector('[aria-hidden]')!.firstElementChild as HTMLElement
    expect(snapshot.inert).toBe(true)
    expect(snapshot.querySelector('img')?.getAttribute('src')).toBe('photo.png')
    expect(snapshot.querySelector('[id]')).toBeNull()
    expect(snapshot.querySelector('[data-message-action-trigger]')).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(1)
    unmount()
    expect(source.style.visibility).toBe('')
    expect(source.querySelector('button')).not.toBeNull()
    source.remove()
  })
})
