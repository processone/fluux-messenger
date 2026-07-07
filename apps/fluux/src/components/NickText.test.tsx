import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { NickText, NickSentence } from './NickText'

describe('NickText', () => {
  it('renders a clean nick verbatim with no markers', () => {
    const { container } = render(<NickText nick="admin" />)
    expect(container.textContent).toBe('admin')
    expect(container.querySelector('[data-testid="nick-ws-marker"]')).toBeNull()
    expect(container.querySelector('[data-testid="nick-hidden-chars"]')).toBeNull()
  })

  it('preserves an internal space without a marker', () => {
    const { container } = render(<NickText nick="ad min" />)
    expect(container.textContent).toBe('ad min')
    expect(container.querySelector('[data-testid="nick-ws-marker"]')).toBeNull()
  })

  it('reveals trailing whitespace with a marker while keeping the name readable', () => {
    const { container } = render(<NickText nick="admin " />)
    expect(container.textContent).toContain('admin')
    expect(container.querySelector('[data-testid="nick-ws-marker"]')).not.toBeNull()
  })

  it('reveals leading whitespace with a marker', () => {
    const { container } = render(<NickText nick=" admin" />)
    expect(container.querySelector('[data-testid="nick-ws-marker"]')).not.toBeNull()
  })

  it('flags a hidden zero-width character with a badge', () => {
    const { container } = render(<NickText nick={'admin​'} />)
    expect(container.querySelector('[data-testid="nick-hidden-chars"]')).not.toBeNull()
  })
})

describe('NickSentence', () => {
  it('renders a translated sentence verbatim for a clean nick', () => {
    const { container } = render(<NickSentence i18nKey="rooms.whisperThread" nick="admin" />)
    expect(container.textContent).toBe('Private with admin')
    expect(container.querySelector('[data-testid="nick-ws-marker"]')).toBeNull()
  })

  it('reveals whitespace on a padded nick interpolated into the sentence', () => {
    const { container } = render(<NickSentence i18nKey="rooms.whisperThread" nick="admin " />)
    expect(container.textContent).toContain('Private with')
    expect(container.querySelector('[data-testid="nick-ws-marker"]')).not.toBeNull()
  })

  it('places the nick correctly when it leads the sentence', () => {
    const { container } = render(<NickSentence i18nKey="rooms.whisperCounterpartGone" nick={'admin​'} />)
    expect(container.textContent).toContain('is no longer in the room')
    expect(container.querySelector('[data-testid="nick-hidden-chars"]')).not.toBeNull()
  })

  it('tolerates an undefined nick without crashing', () => {
    const { container } = render(<NickSentence i18nKey="rooms.whisperThread" nick={undefined} />)
    expect(container.textContent).toBe('Private with ')
  })
})
