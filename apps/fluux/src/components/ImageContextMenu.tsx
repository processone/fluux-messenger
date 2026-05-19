import { useTranslation } from 'react-i18next'
import { Link, ExternalLink, Download } from 'lucide-react'
import { MenuButton } from './sidebar-components/SidebarListMenu'
import { copyToClipboard } from '@/utils/clipboard'
import { isTauri } from '@/utils/tauri'
import type { ContextMenuState } from '@/hooks/useContextMenu'

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
    const link = document.createElement('a')
    link.href = proxiedUrl ?? originalUrl
    link.download = filename || 'image'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <div
      ref={menu.menuRef}
      className="fixed z-50 min-w-[180px] py-1 rounded-lg bg-fluux-bg border border-fluux-border shadow-lg"
      style={{ left: menu.position.x, top: menu.position.y }}
    >
      <MenuButton
        onClick={handleCopyUrl}
        icon={<Link className="w-4 h-4" />}
        label={t('chat.copyImageUrl')}
      />
      <MenuButton
        onClick={handleOpenInBrowser}
        icon={<ExternalLink className="w-4 h-4" />}
        label={t('chat.openInBrowser')}
      />
      <MenuButton
        onClick={handleSave}
        icon={<Download className="w-4 h-4" />}
        label={t('chat.saveImage')}
      />
    </div>
  )
}
