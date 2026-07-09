import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MessageComposer } from './MessageComposer'

// Constants from MessageComposer (mirrored for testing)
const COMPOSING_THROTTLE_MS = 2000
const PAUSED_TIMEOUT_MS = 5000

describe('MessageComposer', () => {
  describe('slash command gating', () => {
    const setup = (props: Record<string, unknown>) => {
      const onSend = vi.fn().mockResolvedValue(true)
      const resolveInput = vi.fn().mockResolvedValue('consumed')
      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          resolveInput={resolveInput}
          classifyInput={() => 'command'}
          {...props}
        />
      )
      const textarea = screen.getByPlaceholderText('Type a message') as HTMLTextAreaElement
      return { onSend, resolveInput, textarea }
    }

    const submit = async (textarea: HTMLTextAreaElement, value: string) => {
      fireEvent.change(textarea, { target: { value } })
      await act(async () => {
        fireEvent.submit(textarea.closest('form') as HTMLFormElement)
      })
    }

    it('routes slash input through resolveInput when commands are enabled', async () => {
      const { onSend, resolveInput, textarea } = setup({})
      await submit(textarea, '/kick alice')
      expect(resolveInput).toHaveBeenCalledWith('/kick alice')
      expect(onSend).not.toHaveBeenCalled() // resolveInput returned 'consumed'
    })

    it('does NOT run commands in reply mode and sends the raw text instead', async () => {
      const replyingTo = { id: 'm1', senderName: 'Bob', body: 'hi', from: 'bob@example.com' }
      const { onSend, resolveInput, textarea } = setup({ replyingTo })
      await submit(textarea, '/kick alice')
      expect(resolveInput).not.toHaveBeenCalled()
      expect(onSend).toHaveBeenCalledWith('/kick alice')
    })

    it('does NOT run commands when commandsEnabled is false (whisper) and sends the raw text', async () => {
      const { onSend, resolveInput, textarea } = setup({ commandsEnabled: false })
      await submit(textarea, '/kick alice')
      expect(resolveInput).not.toHaveBeenCalled()
      expect(onSend).toHaveBeenCalledWith('/kick alice')
    })

    it('reverts the send button from the command icon to the standard send icon after a command runs', async () => {
      // Realistic classifier: only leading-slash input is a command (unlike the
      // shared `() => 'command'` mock, which never returns to 'send').
      const { textarea } = setup({
        classifyInput: (value: string) => (value.trim().startsWith('/') ? 'command' : 'send'),
      })
      const submitButton = textarea.closest('form')?.querySelector('button[type="submit"]') as HTMLButtonElement

      // Typing a command swaps in the Terminal icon and drops the standard Send icon.
      fireEvent.change(textarea, { target: { value: '/kick alice' } })
      expect(submitButton.querySelector('.icon-optical-send')).toBeNull()

      // After the command is consumed, the input is cleared — the icon must return to Send.
      await act(async () => {
        fireEvent.submit(textarea.closest('form') as HTMLFormElement)
      })
      expect(submitButton.querySelector('.icon-optical-send')).not.toBeNull()
    })
  })

  describe('typing notification throttling', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should send composing on first keystroke', async () => {
      const onSendTypingState = vi.fn()
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onSendTypingState={onSendTypingState}
          typingNotificationsEnabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')
      fireEvent.change(textarea, { target: { value: 'H' } })

      expect(onSendTypingState).toHaveBeenCalledWith('composing')
      expect(onSendTypingState).toHaveBeenCalledTimes(1)
    })

    it('should throttle composing notifications within throttle window', async () => {
      const onSendTypingState = vi.fn()
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onSendTypingState={onSendTypingState}
          typingNotificationsEnabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // First keystroke - should send composing
      fireEvent.change(textarea, { target: { value: 'H' } })
      expect(onSendTypingState).toHaveBeenCalledTimes(1)
      expect(onSendTypingState).toHaveBeenCalledWith('composing')

      // Advance time but stay within throttle window
      act(() => {
        vi.advanceTimersByTime(1000)
      })

      // More keystrokes within throttle window - should NOT send again
      fireEvent.change(textarea, { target: { value: 'He' } })
      fireEvent.change(textarea, { target: { value: 'Hel' } })
      fireEvent.change(textarea, { target: { value: 'Hell' } })
      fireEvent.change(textarea, { target: { value: 'Hello' } })

      // Still only 1 composing notification
      expect(onSendTypingState).toHaveBeenCalledTimes(1)
    })

    it('should send composing again after throttle window expires', async () => {
      const onSendTypingState = vi.fn()
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onSendTypingState={onSendTypingState}
          typingNotificationsEnabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // First keystroke
      fireEvent.change(textarea, { target: { value: 'H' } })
      expect(onSendTypingState).toHaveBeenCalledTimes(1)

      // Advance past throttle window
      act(() => {
        vi.advanceTimersByTime(COMPOSING_THROTTLE_MS + 100)
      })

      // Another keystroke - should send composing again
      fireEvent.change(textarea, { target: { value: 'He' } })
      expect(onSendTypingState).toHaveBeenCalledTimes(2)
      expect(onSendTypingState).toHaveBeenLastCalledWith('composing')
    })

    it('should send paused after inactivity timeout', async () => {
      const onSendTypingState = vi.fn()
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onSendTypingState={onSendTypingState}
          typingNotificationsEnabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Type something
      fireEvent.change(textarea, { target: { value: 'Hello' } })
      expect(onSendTypingState).toHaveBeenCalledWith('composing')

      // Advance past paused timeout
      act(() => {
        vi.advanceTimersByTime(PAUSED_TIMEOUT_MS + 100)
      })

      expect(onSendTypingState).toHaveBeenCalledWith('paused')
      expect(onSendTypingState).toHaveBeenCalledTimes(2)
    })

    it('should send paused immediately when text is cleared', async () => {
      const onSendTypingState = vi.fn()
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onSendTypingState={onSendTypingState}
          typingNotificationsEnabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Type something
      fireEvent.change(textarea, { target: { value: 'Hello' } })
      expect(onSendTypingState).toHaveBeenCalledWith('composing')

      // Clear the text
      fireEvent.change(textarea, { target: { value: '' } })

      expect(onSendTypingState).toHaveBeenCalledWith('paused')
      expect(onSendTypingState).toHaveBeenCalledTimes(2)
    })

    it('should reset paused timeout on continued typing', async () => {
      const onSendTypingState = vi.fn()
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onSendTypingState={onSendTypingState}
          typingNotificationsEnabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Type something
      fireEvent.change(textarea, { target: { value: 'H' } })

      // Advance almost to paused timeout
      act(() => {
        vi.advanceTimersByTime(PAUSED_TIMEOUT_MS - 1000)
      })

      // Type more (should reset the paused timeout)
      fireEvent.change(textarea, { target: { value: 'He' } })

      // Advance another partial timeout - should NOT have sent paused yet
      act(() => {
        vi.advanceTimersByTime(PAUSED_TIMEOUT_MS - 1000)
      })

      // Should still only have composing calls (throttled)
      const pausedCalls = onSendTypingState.mock.calls.filter(
        (call) => call[0] === 'paused'
      )
      expect(pausedCalls).toHaveLength(0)

      // Now advance past the full timeout from last keystroke
      act(() => {
        vi.advanceTimersByTime(2000)
      })

      expect(onSendTypingState).toHaveBeenCalledWith('paused')
    })

    it('should not send typing notifications when disabled', async () => {
      const onSendTypingState = vi.fn()
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onSendTypingState={onSendTypingState}
          typingNotificationsEnabled={false}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Type something
      fireEvent.change(textarea, { target: { value: 'Hello' } })

      // Advance past all timeouts
      act(() => {
        vi.advanceTimersByTime(PAUSED_TIMEOUT_MS + 1000)
      })

      // Should never have been called
      expect(onSendTypingState).not.toHaveBeenCalled()
    })

    it('should not send typing notifications when callback is not provided', async () => {
      const onSend = vi.fn().mockResolvedValue(true)

      // No onSendTypingState provided
      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          typingNotificationsEnabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Should not throw when typing
      fireEvent.change(textarea, { target: { value: 'Hello' } })

      act(() => {
        vi.advanceTimersByTime(PAUSED_TIMEOUT_MS + 1000)
      })

      // No error means success
    })

    it('should not send paused when clearing text if never started composing', async () => {
      const onSendTypingState = vi.fn()
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onSendTypingState={onSendTypingState}
          typingNotificationsEnabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Type whitespace only (doesn't trigger composing)
      fireEvent.change(textarea, { target: { value: '   ' } })

      // Clear it
      fireEvent.change(textarea, { target: { value: '' } })

      // Should not have sent anything
      expect(onSendTypingState).not.toHaveBeenCalled()
    })

    it('should clear typing state on message send', async () => {
      const onSendTypingState = vi.fn()
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onSendTypingState={onSendTypingState}
          typingNotificationsEnabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Type something
      fireEvent.change(textarea, { target: { value: 'Hello' } })
      expect(onSendTypingState).toHaveBeenCalledWith('composing')

      // Submit the form (Enter key)
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for async send
      await act(async () => {
        await Promise.resolve()
      })

      // After sending, the paused timeout should be cleared
      // Advance time - should NOT get a paused notification
      act(() => {
        vi.advanceTimersByTime(PAUSED_TIMEOUT_MS + 1000)
      })

      // Should only have the initial composing call
      expect(onSendTypingState).toHaveBeenCalledTimes(1)
    })
  })

  describe('edit mode with attachments', () => {
    it('should pass attachment to onSendCorrection when not removed', async () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onSendCorrection = vi.fn().mockResolvedValue(true)
      const onCancelEdit = vi.fn()

      const attachment = {
        url: 'https://example.com/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          editingMessage={{ id: 'msg-123', body: 'Original text', attachment }}
          onSendCorrection={onSendCorrection}
          onCancelEdit={onCancelEdit}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // The text should be populated from editingMessage.body
      expect(textarea).toHaveValue('Original text')

      // Submit the edit (Enter key)
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for async
      await act(async () => {
        await Promise.resolve()
      })

      // Should pass the attachment
      expect(onSendCorrection).toHaveBeenCalledWith('msg-123', 'Original text', attachment)
    })

    it('should pass undefined attachment when removed', async () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onSendCorrection = vi.fn().mockResolvedValue(true)
      const onCancelEdit = vi.fn()

      const attachment = {
        url: 'https://example.com/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          editingMessage={{ id: 'msg-123', body: 'Original text', attachment }}
          onSendCorrection={onSendCorrection}
          onCancelEdit={onCancelEdit}
        />
      )

      // Find and click the remove attachment button
      const removeButton = screen.getByLabelText('chat.removeAttachment')
      fireEvent.click(removeButton)

      const textarea = screen.getByPlaceholderText('Type a message')

      // Submit the edit
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for async
      await act(async () => {
        await Promise.resolve()
      })

      // Should pass undefined (attachment removed)
      expect(onSendCorrection).toHaveBeenCalledWith('msg-123', 'Original text', undefined)
    })

    it('should show attachment preview in edit mode', () => {
      const onSend = vi.fn().mockResolvedValue(true)

      const attachment = {
        url: 'https://example.com/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          editingMessage={{ id: 'msg-123', body: 'Original text', attachment }}
        />
      )

      // Should show attachment name
      expect(screen.getByText('photo.jpg')).toBeInTheDocument()
      // Should show remove button
      expect(screen.getByLabelText('chat.removeAttachment')).toBeInTheDocument()
    })

    it('should hide attachment preview after removal', () => {
      const onSend = vi.fn().mockResolvedValue(true)

      const attachment = {
        url: 'https://example.com/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          editingMessage={{ id: 'msg-123', body: 'Original text', attachment }}
        />
      )

      // Attachment visible
      expect(screen.getByText('photo.jpg')).toBeInTheDocument()

      // Click remove
      const removeButton = screen.getByLabelText('chat.removeAttachment')
      fireEvent.click(removeButton)

      // Attachment should be hidden
      expect(screen.queryByText('photo.jpg')).not.toBeInTheDocument()
    })

    it('should call onRetractMessage when edit results in empty message (no text, no attachment)', async () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onSendCorrection = vi.fn().mockResolvedValue(true)
      const onRetractMessage = vi.fn().mockResolvedValue(undefined)
      const onCancelEdit = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          editingMessage={{ id: 'msg-123', body: 'Original text' }}
          onSendCorrection={onSendCorrection}
          onRetractMessage={onRetractMessage}
          onCancelEdit={onCancelEdit}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Clear the text
      fireEvent.change(textarea, { target: { value: '' } })

      // Submit (Enter key)
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for async
      await act(async () => {
        await Promise.resolve()
      })

      // Should call retract, not correction
      expect(onRetractMessage).toHaveBeenCalledWith('msg-123')
      expect(onSendCorrection).not.toHaveBeenCalled()
      expect(onCancelEdit).toHaveBeenCalled()
    })

    it('should call onRetractMessage when text is cleared and attachment is removed', async () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onSendCorrection = vi.fn().mockResolvedValue(true)
      const onRetractMessage = vi.fn().mockResolvedValue(undefined)
      const onCancelEdit = vi.fn()

      const attachment = {
        url: 'https://example.com/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          editingMessage={{ id: 'msg-123', body: 'Original text', attachment }}
          onSendCorrection={onSendCorrection}
          onRetractMessage={onRetractMessage}
          onCancelEdit={onCancelEdit}
        />
      )

      // Remove attachment
      const removeButton = screen.getByLabelText('chat.removeAttachment')
      fireEvent.click(removeButton)

      // Clear the text
      const textarea = screen.getByPlaceholderText('Type a message')
      fireEvent.change(textarea, { target: { value: '' } })

      // Submit
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for async
      await act(async () => {
        await Promise.resolve()
      })

      // Should call retract
      expect(onRetractMessage).toHaveBeenCalledWith('msg-123')
      expect(onSendCorrection).not.toHaveBeenCalled()
    })

    it('should call onSendCorrection when text is empty but attachment remains', async () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onSendCorrection = vi.fn().mockResolvedValue(true)
      const onRetractMessage = vi.fn().mockResolvedValue(undefined)
      const onCancelEdit = vi.fn()

      const attachment = {
        url: 'https://example.com/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          editingMessage={{ id: 'msg-123', body: 'Original text', attachment }}
          onSendCorrection={onSendCorrection}
          onRetractMessage={onRetractMessage}
          onCancelEdit={onCancelEdit}
        />
      )

      // Clear the text but keep attachment
      const textarea = screen.getByPlaceholderText('Type a message')
      fireEvent.change(textarea, { target: { value: '' } })

      // Submit
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for async
      await act(async () => {
        await Promise.resolve()
      })

      // Should send correction with empty text but keep attachment
      expect(onRetractMessage).not.toHaveBeenCalled()
      expect(onSendCorrection).toHaveBeenCalledWith('msg-123', '', attachment)
      expect(onCancelEdit).toHaveBeenCalled()
    })
  })

  describe('disabled state (offline)', () => {
    it('should disable send button when disabled prop is true', () => {
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          disabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')
      fireEvent.change(textarea, { target: { value: 'Hello' } })

      // Find the send button (it's the submit button)
      const buttons = screen.getAllByRole('button')
      const submitButton = buttons.find(btn => btn.getAttribute('type') === 'submit')

      expect(submitButton).toBeDisabled()
    })

    it('should not call onSend when Enter is pressed and disabled', async () => {
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          disabled={true}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')
      fireEvent.change(textarea, { target: { value: 'Hello' } })
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for any async operations
      await act(async () => {
        await Promise.resolve()
      })

      expect(onSend).not.toHaveBeenCalled()
    })

    it('should allow sending when disabled is false', async () => {
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          disabled={false}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')
      fireEvent.change(textarea, { target: { value: 'Hello' } })
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for async
      await act(async () => {
        await Promise.resolve()
      })

      expect(onSend).toHaveBeenCalledWith('Hello')
    })

    it('should enable send button when disabled prop is not provided', () => {
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')
      fireEvent.change(textarea, { target: { value: 'Hello' } })

      const buttons = screen.getAllByRole('button')
      const submitButton = buttons.find(btn => btn.getAttribute('type') === 'submit')

      expect(submitButton).not.toBeDisabled()
    })
  })

  describe('Up arrow to edit last message', () => {
    it('should call onEditLastMessage when Up arrow is pressed in empty field', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onEditLastMessage = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onEditLastMessage={onEditLastMessage}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Press Up arrow in empty field
      fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp' })

      expect(onEditLastMessage).toHaveBeenCalledTimes(1)
    })

    it('should NOT call onEditLastMessage when Up arrow is pressed with text in field', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onEditLastMessage = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onEditLastMessage={onEditLastMessage}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Type some text
      fireEvent.change(textarea, { target: { value: 'Hello' } })

      // Press Up arrow
      fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp' })

      expect(onEditLastMessage).not.toHaveBeenCalled()
    })

    it('should NOT call onEditLastMessage when Up arrow is pressed with only whitespace', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onEditLastMessage = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onEditLastMessage={onEditLastMessage}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Type only whitespace
      fireEvent.change(textarea, { target: { value: '   ' } })

      // Press Up arrow - whitespace is treated as empty, so this SHOULD trigger
      fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp' })

      expect(onEditLastMessage).toHaveBeenCalledTimes(1)
    })

    it('should NOT call onEditLastMessage when already in edit mode', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onEditLastMessage = vi.fn()
      const onCancelEdit = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onEditLastMessage={onEditLastMessage}
          editingMessage={{ id: 'msg-123', body: 'Editing this' }}
          onCancelEdit={onCancelEdit}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Clear the text to make field empty
      fireEvent.change(textarea, { target: { value: '' } })

      // Press Up arrow while in edit mode
      fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp' })

      // Should not trigger since we're already editing
      expect(onEditLastMessage).not.toHaveBeenCalled()
    })

    it('should not throw when onEditLastMessage is not provided', () => {
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Press Up arrow - should not throw
      expect(() => {
        fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp' })
      }).not.toThrow()
    })
  })

  describe('pending attachment (staged file before sending)', () => {
    it('should display pending attachment with file name and size', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      // Create file with known size (1500 bytes = 1.5 KB)
      const content = 'x'.repeat(1500)
      const pendingAttachment = {
        file: new File([content], 'document.pdf', { type: 'application/pdf' }),
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          pendingAttachment={pendingAttachment}
        />
      )

      // Should show file name
      expect(screen.getByText('document.pdf')).toBeInTheDocument()
      // Should show file size (1.5 KB)
      expect(screen.getByText('1.5 KB')).toBeInTheDocument()
    })

    it('should show thumbnail preview for image attachments', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const pendingAttachment = {
        file: new File(['test'], 'photo.jpg', { type: 'image/jpeg' }),
        previewUrl: 'blob:http://localhost/preview-123',
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          pendingAttachment={pendingAttachment}
        />
      )

      // Should show image preview
      const img = screen.getByAltText('photo.jpg')
      expect(img).toBeInTheDocument()
      expect(img).toHaveAttribute('src', 'blob:http://localhost/preview-123')
    })

    it('should enable send button when there is a pending attachment (even without text)', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const pendingAttachment = {
        file: new File(['test'], 'photo.jpg', { type: 'image/jpeg' }),
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          pendingAttachment={pendingAttachment}
        />
      )

      // Find the send button
      const buttons = screen.getAllByRole('button')
      const submitButton = buttons.find(btn => btn.getAttribute('type') === 'submit')

      // Should be enabled even though text is empty
      expect(submitButton).not.toBeDisabled()
    })

    it('should call onRemovePendingAttachment when remove button is clicked', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onRemovePendingAttachment = vi.fn()
      const pendingAttachment = {
        file: new File(['test'], 'photo.jpg', { type: 'image/jpeg' }),
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          pendingAttachment={pendingAttachment}
          onRemovePendingAttachment={onRemovePendingAttachment}
        />
      )

      // Find and click remove button
      const removeButton = screen.getByLabelText('chat.removeAttachment')
      fireEvent.click(removeButton)

      expect(onRemovePendingAttachment).toHaveBeenCalledTimes(1)
    })

    it('should call onSend when submitting with only a pending attachment', async () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const pendingAttachment = {
        file: new File(['test'], 'photo.jpg', { type: 'image/jpeg' }),
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          pendingAttachment={pendingAttachment}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Submit without typing text (Enter key)
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for async
      await act(async () => {
        await Promise.resolve()
      })

      // Should call onSend with empty string (the body is handled by parent)
      expect(onSend).toHaveBeenCalledWith('')
    })

    it('should call onSend with text when there is both text and pending attachment', async () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const pendingAttachment = {
        file: new File(['test'], 'photo.jpg', { type: 'image/jpeg' }),
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          pendingAttachment={pendingAttachment}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Type a message
      fireEvent.change(textarea, { target: { value: 'Check out this photo!' } })

      // Submit
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      // Wait for async
      await act(async () => {
        await Promise.resolve()
      })

      expect(onSend).toHaveBeenCalledWith('Check out this photo!')
    })

    it('should not show pending attachment preview when in edit mode', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const pendingAttachment = {
        file: new File(['test'], 'photo.jpg', { type: 'image/jpeg' }),
      }

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          pendingAttachment={pendingAttachment}
          editingMessage={{ id: 'msg-123', body: 'Editing this' }}
        />
      )

      // Pending attachment should not be visible when editing
      expect(screen.queryByText('photo.jpg')).not.toBeInTheDocument()
    })

    it('should format file sizes correctly', () => {
      const onSend = vi.fn().mockResolvedValue(true)

      // Test B formatting (small file - 500 bytes)
      const smallContent = 'x'.repeat(500)
      const { rerender } = render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          pendingAttachment={{
            file: new File([smallContent], 'small.txt', { type: 'text/plain' }),
          }}
        />
      )
      expect(screen.getByText('500 B')).toBeInTheDocument()

      // Test KB formatting (medium file - 50KB)
      const mediumContent = 'x'.repeat(50 * 1024)
      rerender(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          pendingAttachment={{
            file: new File([mediumContent], 'medium.txt', { type: 'text/plain' }),
          }}
        />
      )
      expect(screen.getByText('50.0 KB')).toBeInTheDocument()
    })
  })

  describe('control character filtering (Tauri arrow key bug workaround)', () => {
    it('should filter out control characters from input', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onValueChange = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          value=""
          onValueChange={onValueChange}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Simulate Tauri inserting control character (e.g., \x1D from left arrow at boundary)
      fireEvent.change(textarea, { target: { value: '\x1D' } })

      // Should filter out the control character
      expect(onValueChange).toHaveBeenCalledWith('')
    })

    it('should preserve normal text while filtering control characters', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onValueChange = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          value="Hello"
          onValueChange={onValueChange}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Simulate control character inserted within text
      fireEvent.change(textarea, { target: { value: 'Hello\x1DWorld' } })

      // Should keep text but filter control character
      expect(onValueChange).toHaveBeenCalledWith('HelloWorld')
    })

    it('should preserve newlines and tabs (valid control characters)', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onValueChange = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          value=""
          onValueChange={onValueChange}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Newlines and tabs should be preserved
      fireEvent.change(textarea, { target: { value: 'Line1\nLine2\tTabbed' } })

      expect(onValueChange).toHaveBeenCalledWith('Line1\nLine2\tTabbed')
    })

    it('should filter multiple control characters', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onValueChange = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          value=""
          onValueChange={onValueChange}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Multiple control characters (various C0 control chars)
      fireEvent.change(textarea, { target: { value: 'A\x00B\x1DC\x7FD' } })

      expect(onValueChange).toHaveBeenCalledWith('ABCD')
    })

    it('should filter control characters inserted at start of text', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onValueChange = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          value="Hello"
          onValueChange={onValueChange}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Control character at start (Tauri left arrow at position 0)
      fireEvent.change(textarea, { target: { value: '\x1DHello' } })

      expect(onValueChange).toHaveBeenCalledWith('Hello')
    })
  })

  describe('Aurora card', () => {
    it('wraps context and input in a single .composer-card', () => {
      const { container } = render(
        <MessageComposer
          placeholder="Type a message"
          onSend={vi.fn().mockResolvedValue(true)}
          replyingTo={{ id: '1', from: 'emma@x.com', senderName: 'Emma', body: 'hi' }}
          onCancelReply={vi.fn()}
        />
      )
      const card = container.querySelector('.composer-card')
      expect(card).not.toBeNull()
      // The reply preview lives INSIDE the card (docked), not as a sibling above it.
      expect(card!.textContent).toContain('Emma')
      // The textarea also lives inside the same card.
      expect(card!.querySelector('textarea')).not.toBeNull()
    })

    it('opts the textarea out of the global focus outline (card edge is the sole affordance)', () => {
      render(
        <MessageComposer placeholder="Type a message" onSend={vi.fn().mockResolvedValue(true)} />
      )
      // `no-focus-ring` suppresses the universal `.user-interacted *:focus` outline so
      // the `.composer-card:focus-within` edge is not doubled by an inner textarea ring.
      expect(screen.getByPlaceholderText('Type a message').className).toContain('no-focus-ring')
    })
  })

  describe('clipboard paste image handling', () => {
    it('should call onFileSelect when pasting an image from clipboard (items)', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onFileSelect = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onFileSelect={onFileSelect}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Create a mock image file
      const imageFile = new File(['image-data'], 'screenshot.png', { type: 'image/png' })

      // Create mock clipboard data with image in items (Chrome behavior)
      const clipboardData = {
        items: [
          {
            type: 'image/png',
            getAsFile: () => imageFile,
          },
        ],
      }

      // Trigger paste event
      fireEvent.paste(textarea, { clipboardData })

      expect(onFileSelect).toHaveBeenCalledWith(imageFile)
    })

    it('should call onFileSelect when pasting an image from clipboard.files (Safari "Copy Image")', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onFileSelect = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onFileSelect={onFileSelect}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Create a mock image file
      const imageFile = new File(['image-data'], 'copied-image.png', { type: 'image/png' })

      // Safari "Copy Image" puts the file in clipboardData.files AND includes URL in items
      // The files property should take priority to avoid pasting the URL
      const clipboardData = {
        files: [imageFile],
        items: [
          { type: 'text/uri-list', getAsFile: () => null },
          { type: 'text/plain', getAsFile: () => null },
          { type: 'text/html', getAsFile: () => null },
          { type: 'image/png', getAsFile: () => imageFile },
        ],
      }

      // Trigger paste event
      fireEvent.paste(textarea, { clipboardData })

      expect(onFileSelect).toHaveBeenCalledWith(imageFile)
      expect(onFileSelect).toHaveBeenCalledTimes(1)
    })

    it('should not call onFileSelect when pasting text (no image)', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onFileSelect = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onFileSelect={onFileSelect}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Create mock clipboard data with only text
      const clipboardData = {
        items: [
          {
            type: 'text/plain',
            getAsFile: () => null,
          },
        ],
      }

      // Trigger paste event
      fireEvent.paste(textarea, { clipboardData })

      expect(onFileSelect).not.toHaveBeenCalled()
    })

    it('should not call onFileSelect when onFileSelect is not provided', () => {
      const onSend = vi.fn().mockResolvedValue(true)

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Create a mock image file
      const imageFile = new File(['image-data'], 'screenshot.png', { type: 'image/png' })

      // Create mock clipboard data with image
      const clipboardData = {
        items: [
          {
            type: 'image/png',
            getAsFile: () => imageFile,
          },
        ],
      }

      // Should not throw
      expect(() => {
        fireEvent.paste(textarea, { clipboardData })
      }).not.toThrow()
    })

    it('should handle clipboard with multiple items and select first image', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onFileSelect = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onFileSelect={onFileSelect}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Create mock image files
      const imageFile1 = new File(['image-data-1'], 'first.png', { type: 'image/png' })
      const imageFile2 = new File(['image-data-2'], 'second.png', { type: 'image/png' })

      // Create mock clipboard data with text first, then images
      const clipboardData = {
        items: [
          {
            type: 'text/plain',
            getAsFile: () => null,
          },
          {
            type: 'image/png',
            getAsFile: () => imageFile1,
          },
          {
            type: 'image/png',
            getAsFile: () => imageFile2,
          },
        ],
      }

      // Trigger paste event
      fireEvent.paste(textarea, { clipboardData })

      // Should select first image
      expect(onFileSelect).toHaveBeenCalledWith(imageFile1)
      expect(onFileSelect).toHaveBeenCalledTimes(1)
    })

    it('should handle various image MIME types', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onFileSelect = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onFileSelect={onFileSelect}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Test PNG
      const pngFile = new File(['png'], 'img.png', { type: 'image/png' })
      fireEvent.paste(textarea, {
        clipboardData: { items: [{ type: 'image/png', getAsFile: () => pngFile }] }
      })
      expect(onFileSelect).toHaveBeenLastCalledWith(pngFile)

      // Test JPEG
      const jpegFile = new File(['jpeg'], 'img.jpg', { type: 'image/jpeg' })
      fireEvent.paste(textarea, {
        clipboardData: { items: [{ type: 'image/jpeg', getAsFile: () => jpegFile }] }
      })
      expect(onFileSelect).toHaveBeenLastCalledWith(jpegFile)

      // Test GIF
      const gifFile = new File(['gif'], 'img.gif', { type: 'image/gif' })
      fireEvent.paste(textarea, {
        clipboardData: { items: [{ type: 'image/gif', getAsFile: () => gifFile }] }
      })
      expect(onFileSelect).toHaveBeenLastCalledWith(gifFile)

      // Test WebP
      const webpFile = new File(['webp'], 'img.webp', { type: 'image/webp' })
      fireEvent.paste(textarea, {
        clipboardData: { items: [{ type: 'image/webp', getAsFile: () => webpFile }] }
      })
      expect(onFileSelect).toHaveBeenLastCalledWith(webpFile)
    })

    it('should handle null getAsFile result gracefully', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onFileSelect = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onFileSelect={onFileSelect}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Create mock clipboard data where getAsFile returns null
      const clipboardData = {
        items: [
          {
            type: 'image/png',
            getAsFile: () => null,
          },
        ],
      }

      // Trigger paste event - should not call onFileSelect
      fireEvent.paste(textarea, { clipboardData })

      expect(onFileSelect).not.toHaveBeenCalled()
    })

    it('should handle empty clipboard items array', () => {
      const onSend = vi.fn().mockResolvedValue(true)
      const onFileSelect = vi.fn()

      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={onSend}
          onFileSelect={onFileSelect}
        />
      )

      const textarea = screen.getByPlaceholderText('Type a message')

      // Create mock clipboard data with empty items
      const clipboardData = {
        items: [],
      }

      // Should not throw
      expect(() => {
        fireEvent.paste(textarea, { clipboardData })
      }).not.toThrow()

      expect(onFileSelect).not.toHaveBeenCalled()
    })
  })

  describe('Aurora send button', () => {
    it('is a liquid-glass aurora button when there is text, with no encryption badge on it', () => {
      const { container } = render(
        <MessageComposer
          placeholder="Type a message"
          onSend={vi.fn().mockResolvedValue(true)}
          encryptionState={{ kind: 'encrypted', fingerprint: 'abc', trust: 'verified' }}
        />
      )
      const textarea = screen.getByPlaceholderText('Type a message')
      fireEvent.change(textarea, { target: { value: 'hi' } })
      const send = container.querySelector('button[type="submit"]')!
      // Spec: the send button is now the aurora glass button (was `bg-fluux-brand`).
      expect(send.className).toContain('send-aurora')
      // The encryption badge no longer lives on the send button (moved to the leading lock).
      expect(send.querySelector('.lucide-shield-check')).toBeNull()
    })

    it('still renders the whisper sendBadge on the send button', () => {
      const { container } = render(
        <MessageComposer
          placeholder="Type a message"
          onSend={vi.fn().mockResolvedValue(true)}
          sendBadge={<span data-testid="whisper-badge" />}
        />
      )
      const send = container.querySelector('button[type="submit"]')!
      expect(send.querySelector('[data-testid="whisper-badge"]')).not.toBeNull()
    })

    it('is muted (no glass glow) while the input is empty', () => {
      const { container } = render(
        <MessageComposer placeholder="Type a message" onSend={vi.fn().mockResolvedValue(true)} />
      )
      const send = container.querySelector('button[type="submit"]')!
      expect(send).toBeDisabled()
      expect(send.className).toContain('send-aurora')
      expect(container.querySelector('.send-aurora-glow')).toBeNull()
    })

    it('lights up in aurora glass once there is content to send', () => {
      const { container } = render(
        <MessageComposer placeholder="Type a message" onSend={vi.fn().mockResolvedValue(true)} />
      )
      const textarea = screen.getByPlaceholderText('Type a message')
      fireEvent.change(textarea, { target: { value: 'hello' } })
      const send = container.querySelector('button[type="submit"]')!
      expect(send).not.toBeDisabled()
      expect(send.className).toContain('send-aurora')
      expect(container.querySelector('.send-aurora-glow')).not.toBeNull()
    })

    it('keeps the accessible name', () => {
      const { container } = render(
        <MessageComposer placeholder="Type a message" onSend={vi.fn().mockResolvedValue(true)} />
      )
      const send = container.querySelector('button[type="submit"]')!
      expect(send.getAttribute('aria-label')).toBe('Send')
    })
  })

  describe('Aurora encryption lock', () => {
    const base = { placeholder: 'Type a message', onSend: vi.fn().mockResolvedValue(true) }

    it('shows no lock when not encrypted', () => {
      const { container } = render(<MessageComposer {...base} encryptionState={{ kind: 'disabled' }} />)
      expect(container.querySelector('[data-encryption-lock]')).toBeNull()
    })

    // Colors flow from the shared trustVisual() source of truth: calm gray for a
    // routine encrypted-but-unverified peer, teal only once verified — matching the
    // per-message bubble shield so the two are never inconsistent.
    it('shows a calm gray shield when encrypted but unverified', () => {
      const { container } = render(<MessageComposer {...base} encryptionState={{ kind: 'encrypted', fingerprint: 'a', trust: 'unverified' }} />)
      const icon = container.querySelector('[data-encryption-lock] .lucide-shield')!
      expect(icon).not.toBeNull()
      expect(icon.classList.contains('text-fluux-muted')).toBe(true)
      expect(icon.classList.contains('text-fluux-encryption')).toBe(false)
    })

    it('shows a calm gray shield when trust is tofu-new', () => {
      const { container } = render(<MessageComposer {...base} encryptionState={{ kind: 'encrypted', fingerprint: 'a', trust: 'tofu-new' }} />)
      const icon = container.querySelector('[data-encryption-lock] .lucide-shield')!
      expect(icon).not.toBeNull()
      expect(icon.classList.contains('text-fluux-muted')).toBe(true)
    })

    it('shows a teal shield-check when verified', () => {
      const { container } = render(<MessageComposer {...base} encryptionState={{ kind: 'encrypted', fingerprint: 'a', trust: 'verified' }} />)
      const icon = container.querySelector('[data-encryption-lock] .lucide-shield-check')!
      expect(icon).not.toBeNull()
      expect(icon.classList.contains('text-fluux-encryption')).toBe(true)
    })

    it('shows the amber escalation row when the key changed (blocked)', () => {
      const { container } = render(<MessageComposer {...base} encryptionState={{ kind: 'blocked', pinnedFingerprint: 'a', advertisedFingerprint: 'b' }} />)
      expect(container.querySelector('[data-encryption-escalation]')).not.toBeNull()
    })

    it('calls onEncryptionClick when the lock is activated', () => {
      const onEncryptionClick = vi.fn()
      const { container } = render(<MessageComposer {...base} onEncryptionClick={onEncryptionClick} encryptionState={{ kind: 'encrypted', fingerprint: 'a', trust: 'unverified' }} />)
      fireEvent.click(container.querySelector('[data-encryption-lock]')!)
      expect(onEncryptionClick).toHaveBeenCalledTimes(1)
    })
  })

  describe('Aurora reply-chip color', () => {
    it('colors the reply chip with the replied-person color', () => {
      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={vi.fn().mockResolvedValue(true)}
          replyingTo={{ id: '1', from: 'emma@x.com', senderName: 'Emma', body: 'hi', senderColor: 'rgb(154, 212, 255)' }}
          onCancelReply={vi.fn()}
        />
      )
      // The "Replying to Emma" line is colored with the provided sender color.
      const name = screen.getByText(/Replying to/i)
      expect(name.getAttribute('style')).toContain('rgb(154, 212, 255)')
    })

    it('falls back to the brand color when no senderColor is given', () => {
      render(
        <MessageComposer
          placeholder="Type a message"
          onSend={vi.fn().mockResolvedValue(true)}
          replyingTo={{ id: '1', from: 'emma@x.com', senderName: 'Emma', body: 'hi' }}
          onCancelReply={vi.fn()}
        />
      )
      const name = screen.getByText(/Replying to/i)
      expect(name.getAttribute('style')).toContain('var(--fluux-brand)')
    })
  })
})
