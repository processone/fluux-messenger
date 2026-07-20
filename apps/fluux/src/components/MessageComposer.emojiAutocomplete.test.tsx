import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MessageComposer } from './MessageComposer'

vi.mock('@emoji-mart/data', () => ({
  default: {
    emojis: {
      heart: {
        name: 'Red Heart',
        skins: [{ native: '❤️' }],
        keywords: ['love'],
      },
      heart_eyes: {
        name: 'Smiling Face with Heart-Eyes',
        skins: [{ native: '😍' }],
        keywords: ['love'],
      },
    },
  },
}))

vi.mock('./EmojiPicker', () => ({
  EmojiPicker: () => <div data-testid="full-emoji-picker" />,
}))

function renderComposer(props: Partial<React.ComponentProps<typeof MessageComposer>> = {}) {
  return render(
    <MessageComposer
      placeholder="Type a message"
      onSend={vi.fn().mockResolvedValue(true)}
      {...props}
    />
  )
}

function ControlledComposer() {
  const [value, setValue] = useState('')
  return (
    <MessageComposer
      placeholder="Type a message"
      onSend={vi.fn().mockResolvedValue(true)}
      value={value}
      onValueChange={setValue}
    />
  )
}

function typeEmojiToken() {
  const textarea = screen.getByPlaceholderText('Type a message') as HTMLTextAreaElement
  fireEvent.change(textarea, {
    target: { value: ':hea', selectionStart: 4, selectionEnd: 4 },
  })
}

async function expectEscapeClosesBeforeCancel(
  props: Partial<React.ComponentProps<typeof MessageComposer>>,
  onCancel: ReturnType<typeof vi.fn>
) {
  renderComposer(props)
  typeEmojiToken()

  const textarea = screen.getByRole('combobox', { name: 'Type a message' })
  await waitFor(() => {
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  fireEvent.keyDown(textarea, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(onCancel).not.toHaveBeenCalled()

  fireEvent.keyDown(textarea, { key: 'Escape' })
  expect(onCancel).toHaveBeenCalledOnce()
}

describe('MessageComposer emoji overlay coordination', () => {
  it('exposes listbox semantics and keeps textarea focus during keyboard navigation', async () => {
    renderComposer()
    typeEmojiToken()

    const textarea = screen.getByRole('combobox', { name: 'Type a message' })
    await waitFor(() => {
      expect(textarea).toHaveAttribute('aria-expanded', 'true')
    })

    const listbox = screen.getByRole('listbox')
    const option = screen.getByRole('option', { name: ':heart: Red Heart' })
    const nextOption = screen.getByRole('option', { name: ':heart_eyes: Smiling Face with Heart-Eyes' })
    expect(listbox).toHaveAttribute('id')
    expect(textarea).toHaveAttribute('aria-controls', listbox.id)
    expect(textarea).toHaveAttribute('aria-activedescendant', option.id)
    expect(option).toHaveAttribute('aria-selected', 'true')
    expect(option.querySelector('[aria-hidden="true"]')).toHaveTextContent('❤️')

    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(textarea)
    expect(textarea).toHaveAttribute('aria-activedescendant', nextOption.id)
    expect(option).toHaveAttribute('aria-selected', 'false')
    expect(nextOption).toHaveAttribute('aria-selected', 'true')
  })

  it('completes from the keyboard and restores the cursor in uncontrolled mode', async () => {
    renderComposer()
    typeEmojiToken()

    const textarea = screen.getByRole('combobox', { name: 'Type a message' }) as HTMLTextAreaElement
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(textarea).toHaveValue('❤️')
      expect(textarea.selectionStart).toBe('❤️'.length)
      expect(document.activeElement).toBe(textarea)
    })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('completes from a click and restores the cursor in controlled mode', async () => {
    render(<ControlledComposer />)
    typeEmojiToken()

    const textarea = screen.getByRole('combobox', { name: 'Type a message' }) as HTMLTextAreaElement
    const option = await screen.findByRole('option', { name: ':heart: Red Heart' })
    fireEvent.mouseDown(option)
    fireEvent.click(option)

    await waitFor(() => {
      expect(textarea).toHaveValue('❤️')
      expect(textarea.selectionStart).toBe('❤️'.length)
      expect(document.activeElement).toBe(textarea)
    })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('preserves Shift+Enter as a newline while suggestions are open', async () => {
    renderComposer()
    typeEmojiToken()

    const textarea = screen.getByRole('combobox', { name: 'Type a message' }) as HTMLTextAreaElement
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    expect(fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })).toBe(true)
    fireEvent.change(textarea, {
      target: { value: ':hea\n', selectionStart: 5, selectionEnd: 5 },
    })

    expect(textarea).toHaveValue(':hea\n')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('gives an external composer overlay priority over emoji completion', async () => {
    const { rerender } = renderComposer({
      aboveInput: <div data-testid="external-overlay" />,
      hasExternalOverlay: true,
    })

    typeEmojiToken()
    expect(screen.getByTestId('external-overlay')).toBeInTheDocument()
    expect(screen.queryByText(':heart:')).not.toBeInTheDocument()

    rerender(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        hasExternalOverlay={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByText(':heart:')).toBeInTheDocument()
    })
  })

  it('closes the attachment drawer when emoji completion opens', async () => {
    renderComposer({ onCreatePoll: vi.fn() })

    fireEvent.click(screen.getByLabelText('upload.attachFile'))
    expect(screen.getByText('Create Poll')).toBeInTheDocument()

    typeEmojiToken()
    await waitFor(() => {
      expect(screen.getByText(':heart:')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.queryByText('Create Poll')).not.toBeInTheDocument()
    })
  })

  it('closes the full emoji picker when emoji completion opens', async () => {
    const { container } = renderComposer()
    const emojiButton = container.querySelector<HTMLButtonElement>('[class*="grid-area:emoji"] > button')
    expect(emojiButton).not.toBeNull()

    fireEvent.click(emojiButton!)
    await waitFor(() => {
      expect(screen.getByTestId('full-emoji-picker')).toBeInTheDocument()
    })

    typeEmojiToken()
    await waitFor(() => {
      expect(screen.getByText(':heart:')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.queryByTestId('full-emoji-picker')).not.toBeInTheDocument()
    })
  })

  it('uses Escape to close autocomplete before cancelling reply mode', async () => {
    const onCancelReply = vi.fn()
    await expectEscapeClosesBeforeCancel({
      replyingTo: { id: 'reply-1', senderName: 'Alice', body: 'Hello', from: 'alice@example.com' },
      onCancelReply,
    }, onCancelReply)
  })

  it('uses Escape to close autocomplete before cancelling edit mode', async () => {
    const onCancelEdit = vi.fn()
    await expectEscapeClosesBeforeCancel({
      editingMessage: { id: 'edit-1', body: 'Original message' },
      onCancelEdit,
    }, onCancelEdit)
  })
})
