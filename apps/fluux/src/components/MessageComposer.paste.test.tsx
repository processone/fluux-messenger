import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import * as nativeClipboard from '@/utils/nativeClipboard'
import { useToastStore } from '@/stores/toastStore'
import finderText from './__fixtures__/finder-paste.txt?raw'
import { MessageComposer } from './MessageComposer'

// A trusted macOS Finder paste exposed this text fixture as a File with types
// ['Files'], while the native clipboard also offered Finder's document icon.
function finderClipboard() {
  const file = new File([finderText], 'finder-paste.txt', { type: 'text/plain' })
  return {
    files: [file],
    items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
    types: ['Files'],
  }
}

describe('Finder file paste', () => {
  it('selects the original text File before reading the native document icon', async () => {
    const readImage = vi.spyOn(nativeClipboard, 'readClipboardImage').mockResolvedValue(null)
    const onFileSelect = vi.fn()
    const clipboardData = finderClipboard()
    render(<MessageComposer placeholder="Message" onSend={vi.fn()} onFileSelect={onFileSelect} />)

    try {
      await act(async () => {
        expect(fireEvent.paste(screen.getByPlaceholderText('Message'), { clipboardData })).toBe(false)
      })
      expect(onFileSelect).toHaveBeenCalledExactlyOnceWith(clipboardData.files[0])
      expect(readImage).not.toHaveBeenCalled()
    } finally {
      readImage.mockRestore()
    }
  })

  it('still refuses the original file when attachments are disabled', async () => {
    const readImage = vi.spyOn(nativeClipboard, 'readClipboardImage').mockResolvedValue(null)
    const onFileSelect = vi.fn()
    const reason = 'Files cannot be sent in private room messages.'
    useToastStore.setState({ toasts: [] })
    render(<MessageComposer placeholder="Message" onSend={vi.fn()} onFileSelect={onFileSelect}
      attachmentDisabledReason={reason} />)

    try {
      await act(async () => {
        expect(fireEvent.paste(screen.getByPlaceholderText('Message'), {
          clipboardData: finderClipboard(),
        })).toBe(false)
      })
      expect(onFileSelect).not.toHaveBeenCalled()
      expect(readImage).not.toHaveBeenCalled()
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(reason)
    } finally {
      readImage.mockRestore()
    }
  })
})
