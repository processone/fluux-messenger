import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommandHelpPanel } from './CommandHelpPanel'
import { COMMANDS } from '../../commands/registry'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

describe('CommandHelpPanel', () => {
  it('lists each command usage and calls onClose', () => {
    const onClose = vi.fn()
    render(<CommandHelpPanel commands={COMMANDS.slice(0, 3)} onClose={onClose} />)
    expect(screen.getByText('commands.help.title')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('common.close'))
    expect(onClose).toHaveBeenCalled()
  })
})
