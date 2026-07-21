import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImageContextMenu } from './ImageContextMenu'
import type { ContextMenuState } from '@/hooks/useContextMenu'

const { downloadFileSpy, downloadAttachmentSpy, copyToClipboardSpy } = vi.hoisted(() => ({
  downloadFileSpy: vi.fn(),
  downloadAttachmentSpy: vi.fn(),
  copyToClipboardSpy: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/utils/download', () => ({
  downloadFile: (...args: unknown[]) => downloadFileSpy(...args),
  downloadAttachment: (...args: unknown[]) => downloadAttachmentSpy(...args),
}))
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: (...args: unknown[]) => copyToClipboardSpy(...args) }))
vi.mock('@/utils/openInBrowser', () => ({ openInBrowser: vi.fn() }))
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: () => {} }))

function makeMenu(): ContextMenuState {
  return {
    isOpen: true,
    position: { x: 10, y: 20 },
    menuRef: createRef<HTMLDivElement>(),
    longPressTriggered: { current: false },
    close: vi.fn(),
    handleContextMenu: vi.fn(),
    handleTouchStart: vi.fn(),
    handleTouchEnd: vi.fn(),
  }
}

describe('ImageContextMenu save (encrypted)', () => {
  const encryption = { cipher: 'aes-256-gcm' as const, key: new Uint8Array(32), iv: new Uint8Array(12) }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('with no decrypted URL, decrypts on demand — never saves the ciphertext URL', () => {
    render(
      <ImageContextMenu
        originalUrl="https://x/cipher.bin"
        proxiedUrl={null}
        encryption={encryption}
        filename="secret.jpg"
        menu={makeMenu()}
      />,
    )
    fireEvent.click(screen.getByText('chat.saveImage'))

    expect(downloadAttachmentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x/cipher.bin', encryption }),
      expect.anything(),
    )
    // The raw ciphertext URL is never handed to the direct save path.
    expect(downloadFileSpy).not.toHaveBeenCalled()
  })

  it('saves the decrypted blob directly once resolved (no re-decrypt)', () => {
    render(
      <ImageContextMenu
        originalUrl="https://x/cipher.bin"
        proxiedUrl="blob:decrypted"
        encryption={encryption}
        filename="secret.jpg"
        menu={makeMenu()}
      />,
    )
    fireEvent.click(screen.getByText('chat.saveImage'))
    expect(downloadFileSpy).toHaveBeenCalledWith('blob:decrypted', 'secret.jpg', expect.anything())
    expect(downloadAttachmentSpy).not.toHaveBeenCalled()
  })
})

describe('ImageContextMenu save (plaintext)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves the proxied URL when present', () => {
    render(
      <ImageContextMenu
        originalUrl="https://x/plain.jpg"
        proxiedUrl="blob:proxied"
        filename="plain.jpg"
        menu={makeMenu()}
      />,
    )
    fireEvent.click(screen.getByText('chat.saveImage'))
    expect(downloadFileSpy).toHaveBeenCalledWith('blob:proxied', 'plain.jpg', expect.anything())
    expect(downloadAttachmentSpy).not.toHaveBeenCalled()
  })

  it('falls back to the original URL when nothing is proxied (unencrypted only)', () => {
    render(
      <ImageContextMenu
        originalUrl="https://x/plain.jpg"
        proxiedUrl={null}
        filename="plain.jpg"
        menu={makeMenu()}
      />,
    )
    fireEvent.click(screen.getByText('chat.saveImage'))
    expect(downloadFileSpy).toHaveBeenCalledWith('https://x/plain.jpg', 'plain.jpg', expect.anything())
    expect(downloadAttachmentSpy).not.toHaveBeenCalled()
  })
})
