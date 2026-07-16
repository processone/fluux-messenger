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
        encryptionState={{ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'tofu' }}
      />
    )

    const row = screen.getByPlaceholderText('Type a message').closest('.composer-actions')
    expect(row!.innerHTML).toContain('grid-area:lock')
  })

  it('marks the +/emoji controls as collapsible drawer items', () => {
    render(<MessageComposer placeholder="Type a message" onSend={onSend} />)

    const row = screen.getByPlaceholderText('Type a message').closest('.composer-actions')!

    // No encryption → only the + and emoji wrappers are drawer items.
    const drawerItems = row.querySelectorAll('.composer-drawer-item')
    expect(drawerItems.length).toBe(2)

    const add = row.querySelector('[class*="grid-area:add"]')
    const emoji = row.querySelector('[class*="grid-area:emoji"]')
    expect(add?.classList.contains('composer-drawer-item')).toBe(true)
    expect(emoji?.classList.contains('composer-drawer-item')).toBe(true)
  })

  it('marks the encryption lock as a drawer item when encrypted', () => {
    render(
      <MessageComposer
        placeholder="Type a message"
        onSend={onSend}
        encryptionState={{ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'tofu' }}
      />
    )

    const row = screen.getByPlaceholderText('Type a message').closest('.composer-actions')!
    const lock = row.querySelector('[class*="grid-area:lock"]')
    expect(lock?.classList.contains('composer-drawer-item')).toBe(true)
    // + / lock / emoji are all drawer items now.
    expect(row.querySelectorAll('.composer-drawer-item').length).toBe(3)
  })
})
