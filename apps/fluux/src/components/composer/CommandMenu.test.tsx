import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommandMenu } from './CommandMenu'
import { COMMANDS } from '../../commands/registry'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

describe('CommandMenu', () => {
  const kick = COMMANDS.find((c) => c.name === 'kick')!
  const nick = COMMANDS.find((c) => c.name === 'nick')!

  it('renders one row per match with the command name', () => {
    render(<CommandMenu matches={[kick, nick]} selectedIndex={0} onSelect={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText('/kick')).toBeInTheDocument()
    expect(screen.getByText('/nick')).toBeInTheDocument()
  })
  it('fires onSelect with the clicked index', () => {
    const onSelect = vi.fn()
    render(<CommandMenu matches={[kick, nick]} selectedIndex={0} onSelect={onSelect} onDismiss={() => {}} />)
    fireEvent.click(screen.getByText('/nick'))
    expect(onSelect).toHaveBeenCalledWith(1)
  })
  it('dismisses on a pointer press outside the popover', () => {
    const onDismiss = vi.fn()
    render(
      <div>
        <button type="button">outside</button>
        <CommandMenu matches={[kick, nick]} selectedIndex={0} onSelect={() => {}} onDismiss={onDismiss} />
      </div>,
    )
    fireEvent.pointerDown(screen.getByText('outside'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
  it('does not dismiss on a pointer press inside the popover', () => {
    const onDismiss = vi.fn()
    render(<CommandMenu matches={[kick, nick]} selectedIndex={0} onSelect={() => {}} onDismiss={onDismiss} />)
    fireEvent.pointerDown(screen.getByText('/nick'))
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
