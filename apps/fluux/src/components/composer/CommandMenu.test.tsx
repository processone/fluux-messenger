import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommandMenu } from './CommandMenu'
import { COMMANDS } from '../../commands/registry'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

describe('CommandMenu', () => {
  const kick = COMMANDS.find((c) => c.name === 'kick')!
  const nick = COMMANDS.find((c) => c.name === 'nick')!

  it('renders one row per match with the command name', () => {
    render(<CommandMenu matches={[kick, nick]} selectedIndex={0} onSelect={() => {}} />)
    expect(screen.getByText('/kick')).toBeInTheDocument()
    expect(screen.getByText('/nick')).toBeInTheDocument()
  })
  it('fires onSelect with the clicked index', () => {
    const onSelect = vi.fn()
    render(<CommandMenu matches={[kick, nick]} selectedIndex={0} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('/nick'))
    expect(onSelect).toHaveBeenCalledWith(1)
  })
})
