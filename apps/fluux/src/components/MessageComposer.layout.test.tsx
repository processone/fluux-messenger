import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageComposer } from './MessageComposer'

describe('MessageComposer responsive layout', () => {
  const onSend = vi.fn().mockResolvedValue(true)

  it('lays the action row out as a grid with named areas', () => {
    render(<MessageComposer placeholder="Type a message" onSend={onSend} />)

    const textarea = screen.getByPlaceholderText('Type a message')
    const row = textarea.closest('.composer-actions')
    expect(row).not.toBeNull()

    // The text field occupies the `input` grid area.
    expect(textarea.className).toContain('[grid-area:input]')

    // The flanking controls carry their own grid areas so the template can
    // place them on either one row (wide) or two rows (narrow).
    expect(row!.innerHTML).toContain('grid-area:add')
    expect(row!.innerHTML).toContain('grid-area:emoji')
    expect(row!.innerHTML).toContain('grid-area:send')
  })

  it('places the encryption lock in the `lock` grid area when encrypted', () => {
    render(
      <MessageComposer
        placeholder="Type a message"
        onSend={onSend}
        encryptionState={{ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'unverified' }}
      />
    )

    const row = screen.getByPlaceholderText('Type a message').closest('.composer-actions')
    expect(row!.innerHTML).toContain('grid-area:lock')
  })
})
