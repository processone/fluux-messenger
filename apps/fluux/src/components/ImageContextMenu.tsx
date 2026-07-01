import { useTranslation } from 'react-i18next'
import { Link, ExternalLink, Download } from 'lucide-react'
import { MenuButton } from './sidebar-components/SidebarListMenu'
import { copyToClipboard } from '@/utils/clipboard'
import { isTauri } from '@/utils/tauri'
import { downloadFile } from '@/utils/download'
import type { ContextMenuState } from '@/hooks/useContextMenu'
import { useFocusTrap } from '@/hooks/useFocusTrap'

interface ImageContextMenuProps {
  originalUrl: string
  proxiedUrl: string | null
  filename?: string
  menu: ContextMenuState
}

async function openInBrowser(url: string): Promise<void> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

export function ImageContextMenu({ originalUrl, proxiedUrl, filename, menu }: ImageContextMenuProps) {
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
    void downloadFile(proxiedUrl ?? originalUrl, filename || 'image', {
      errorMessage: t('common.downloadFailed'),
    })
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
