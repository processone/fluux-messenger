import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { CommandMenu } from './CommandMenu'
import { COMMANDS } from '../../commands/registry'
import { installScrollbarReveal } from '../../utils/scrollbarReveal'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

/** FLM-318: a completion menu scrolled by Up/Down while focus stays in the composer reveals its own thumb. */
describe('composer completion menu thumb', () => {
  const kick = COMMANDS.find((c) => c.name === 'kick')!
  const nick = COMMANDS.find((c) => c.name === 'nick')!
  let uninstall: () => void
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    uninstall = installScrollbarReveal(window)
  })
  afterEach(() => uninstall())

  const setup = () => {
    const props = { matches: [kick, nick], onSelect: () => {}, onDismiss: () => {} }
    const view = render(<CommandMenu {...props} selectedIndex={0} />)
    const menu = view.container.firstElementChild as HTMLElement
    menu.style.overflowY = 'auto'
    Object.defineProperty(menu, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(menu, 'clientHeight', { value: 100, configurable: true })
    const composer = document.createElement('textarea')
    document.body.appendChild(composer)
    return { view, menu, composer, props }
  }

  it('reveals after an ArrowDown moved the selection', () => {
    const { view, menu, composer, props } = setup()
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    view.rerender(<CommandMenu {...props} selectedIndex={1} />)
    menu.dispatchEvent(new Event('scroll'))
    expect(menu.hasAttribute('data-scrolling')).toBe(true)
  })

  it('does not reveal when the selection resets without a key', () => {
    const { view, menu, props } = setup()
    view.rerender(<CommandMenu {...props} selectedIndex={1} />)
    menu.dispatchEvent(new Event('scroll'))
    expect(menu.hasAttribute('data-scrolling')).toBe(false)
  })
})
