import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEffect } from 'react'
import { act, render } from '@testing-library/react'
import { CommandMenu } from './CommandMenu'
import { useCommandMenu } from '../../hooks/useCommandMenu'
import { installScrollbarReveal } from '../../utils/scrollbarReveal'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

/**
 * FLM-318: a completion menu whose selection the key handler moved reveals its own
 * thumb; a reset does not, whatever arrow keys came before it and however late it lands.
 */
describe('composer completion menu thumb', () => {
  let uninstall: () => void
  let handler: ReturnType<typeof useCommandMenu>
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    uninstall = installScrollbarReveal(window)
  })
  afterEach(() => uninstall())

  /** The real useCommandMenu feeding the real CommandMenu, as RoomView wires them. */
  function Harness({ text }: { text: string }) {
    const menu = useCommandMenu(text, text.length, 'room', { role: 'moderator', affiliation: 'owner' })
    useEffect(() => {
      handler = menu
    })
    const handlerState = menu.state
    return (
      <CommandMenu
        matches={handlerState.matches}
        selectedIndex={handlerState.selectedIndex}
        navSerial={handlerState.navSerial}
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    )
  }
  const setup = () => {
    const view = render(<Harness text="/" />)
    const menu = view.container.firstElementChild as HTMLElement
    menu.style.overflowY = 'auto'
    Object.defineProperty(menu, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(menu, 'clientHeight', { value: 100, configurable: true })
    return { view, menu }
  }

  it('reveals after the handler moved the selection, however late the commit lands', () => {
    vi.useFakeTimers()
    const { menu } = setup()
    act(() => {
      vi.advanceTimersByTime(5000) // no timing window decides this
      handler.moveSelection('down')
    })
    menu.dispatchEvent(new Event('scroll'))
    expect(menu.hasAttribute('data-scrolling')).toBe(true)
    vi.useRealTimers()
  })

  it('does not reveal when an edit resets the selection after an unrelated arrow key', () => {
    const { view, menu } = setup()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    view.rerender(<Harness text="/k" />) // typing resets the highlight
    menu.dispatchEvent(new Event('scroll'))
    expect(menu.hasAttribute('data-scrolling')).toBe(false)
  })
})
