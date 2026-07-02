import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AdminCommandForm } from './AdminCommandForm'
import type { DataForm } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('AdminCommandForm', () => {
  describe('accountjid pre-fill (XEP-0133 single-field commands)', () => {
    const form: DataForm = {
      type: 'form',
      title: 'Delete User',
      fields: [
        { var: 'accountjid', type: 'jid-single', label: 'JID' },
      ],
    }

    it('pre-fills and hides accountjid when targetJid is set', () => {
      const onSubmit = vi.fn()
      const { container } = render(
        <AdminCommandForm
          form={form}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          targetJid="alice@example.com"
        />
      )

      // Field is hidden (shown via the target-user banner instead).
      expect(screen.queryByRole('textbox', { name: /jid/i })).not.toBeInTheDocument()
      expect(screen.getByText('alice@example.com')).toBeInTheDocument()

      fireEvent.submit(container.querySelector('form')!)
      expect(onSubmit).toHaveBeenCalledWith({ accountjid: 'alice@example.com' })
    })
  })

  describe('user/host pre-fill (ejabberd api-commands split-JID commands)', () => {
    const form: DataForm = {
      type: 'form',
      title: 'Ban Account',
      fields: [
        { var: 'user', type: 'text-single', label: 'user' },
        { var: 'host', type: 'text-single', label: 'host' },
        { var: 'reason', type: 'text-single', label: 'reason' },
      ],
    }

    it('pre-fills user and host from targetJid and hides both behind the target banner', () => {
      const onSubmit = vi.fn()
      const { container } = render(
        <AdminCommandForm
          form={form}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          targetJid="emma@fluux.chat"
        />
      )

      expect(container.querySelector('input[name="user"]')).not.toBeInTheDocument()
      expect(container.querySelector('input[name="host"]')).not.toBeInTheDocument()
      expect(screen.getByText('emma@fluux.chat')).toBeInTheDocument()
      // The unrelated field still renders normally.
      expect(container.querySelector('input[name="reason"]')).toBeInTheDocument()
    })

    it('submits the derived user/host from targetJid alongside other field values', () => {
      const onSubmit = vi.fn()
      const { container } = render(
        <AdminCommandForm
          form={form}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          targetJid="emma@fluux.chat"
        />
      )

      fireEvent.change(container.querySelector('input[name="reason"]')!, {
        target: { value: 'Spamming' },
      })
      fireEvent.submit(container.querySelector('form')!)

      expect(onSubmit).toHaveBeenCalledWith({
        user: 'emma',
        host: 'fluux.chat',
        reason: 'Spamming',
      })
    })

    it('does not auto-fill a lone user field when there is no matching host field', () => {
      const lonelyForm: DataForm = {
        type: 'form',
        title: 'Unrelated command',
        fields: [{ var: 'user', type: 'text-single', label: 'user' }],
      }
      const { container } = render(
        <AdminCommandForm
          form={lonelyForm}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          targetJid="emma@fluux.chat"
        />
      )

      const input = container.querySelector('input[name="user"]') as HTMLInputElement
      expect(input).toBeInTheDocument()
      expect(input.value).toBe('')
    })
  })

  describe('no targetJid', () => {
    it('renders user/host fields normally, using server-supplied defaults', () => {
      const form: DataForm = {
        type: 'form',
        title: 'Ban Account',
        fields: [
          { var: 'user', type: 'text-single', label: 'user' },
          { var: 'host', type: 'text-single', label: 'host', value: 'fluux.chat' },
        ],
      }
      const { container } = render(
        <AdminCommandForm form={form} onSubmit={vi.fn()} onCancel={vi.fn()} />
      )

      expect(container.querySelector('input[name="user"]')).toBeInTheDocument()
      expect((container.querySelector('input[name="host"]') as HTMLInputElement).value).toBe('fluux.chat')
    })
  })
})
