import { useTranslation } from 'react-i18next'
import { Link, ExternalLink, Download } from 'lucide-react'
import type { FileEncryption } from '@fluux/sdk'
import { MenuButton } from './sidebar-components/SidebarListMenu'
import { copyToClipboard } from '@/utils/clipboard'
import { openInBrowser } from '@/utils/openInBrowser'
import { downloadFile, downloadAttachment } from '@/utils/download'
import type { ContextMenuState } from '@/hooks/useContextMenu'
import { useFocusTrap } from '@/hooks/useFocusTrap'

interface ImageContextMenuProps {
  originalUrl: string
  /** Already-resolved (decrypted/proxied) blob URL, or null when not yet available. */
  proxiedUrl: string | null
  /** Encryption params when the image is AES-GCM ciphertext; gates the decrypt-on-save path. */
  encryption?: FileEncryption
  filename?: string
  menu: ContextMenuState
}

export function ImageContextMenu({ originalUrl, proxiedUrl, encryption, filename, menu }: ImageContextMenuProps) {
  const { t } = useTranslation()

  // This menu can render inside an already-trapped overlay (e.g. ImageLightbox). A Tab keydown
  // bubbles through both container listeners; this is safe because the inner handler moves focus
  // first and the outer handler then no-ops (active element is still inside its container).
  useFocusTrap(menu.menuRef, { active: menu.isOpen })

  if (!menu.isOpen) return null

  const handleCopyUrl = () => {
    menu.close()
    void copyToClipboard(originalUrl)
  }

  const handleOpenInBrowser = () => {
    menu.close()
    void openInBrowser(originalUrl)
  }

  const handleSave = () => {
    menu.close()
    const options = { errorMessage: t('common.downloadFailed') }
    if (proxiedUrl) {
      // Already-resolved bytes (decrypted or plaintext-proxied): save them directly.
      void downloadFile(proxiedUrl, filename || 'image', options)
    } else if (encryption) {
      // Encrypted but not yet resolved: decrypt on demand. The ciphertext URL is
      // never handed to the save path.
      void downloadAttachment({ url: originalUrl, name: filename, encryption }, options)
    } else {
      void downloadFile(originalUrl, filename || 'image', options)
    }
  }

  return (
    <div
      ref={menu.menuRef}
      className="fixed z-50 min-w-[180px] py-1 rounded-lg fluux-popover"
      style={{ left: menu.position.x, top: menu.position.y }}
    >
      <MenuButton
        onClick={handleCopyUrl}
        icon={<Link className="size-4" />}
        label={t('chat.copyImageUrl')}
      />
      <MenuButton
        onClick={handleOpenInBrowser}
        icon={<ExternalLink className="size-4" />}
        label={t('chat.openInBrowser')}
      />
      <MenuButton
        onClick={handleSave}
        icon={<Download className="size-4" />}
        label={t('chat.saveImage')}
      />
    </div>
  )
}
