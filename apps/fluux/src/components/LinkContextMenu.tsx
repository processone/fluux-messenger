import { useTranslation } from 'react-i18next'
import { Copy, ExternalLink } from 'lucide-react'
import { MenuButton } from './sidebar-components/SidebarListMenu'
import { copyToClipboard } from '@/utils/clipboard'
import { openInBrowser } from '@/utils/openInBrowser'
import type { ContextMenuState } from '@/hooks/useContextMenu'
import { useFocusTrap } from '@/hooks/useFocusTrap'

interface LinkContextMenuProps {
  url: string
  menu: ContextMenuState
}

/**
 * Right-click / long-press menu for a hyperlink in a message. Mirrors
 * ImageContextMenu: a small popover positioned at the click point with
 * "Copy link" and "Open in browser". Rendered by MessageLink.
 */
export function LinkContextMenu({ url, menu }: LinkContextMenuProps) {
  const { t } = useTranslation()
  useFocusTrap(menu.menuRef, { active: menu.isOpen })

  if (!menu.isOpen) return null

  const handleCopy = () => {
    menu.close()
    void copyToClipboard(url)
  }

  const handleOpen = () => {
    menu.close()
    void openInBrowser(url)
  }

  return (
    <div
      ref={menu.menuRef}
      className="fixed z-50 min-w-[180px] py-1 rounded-lg fluux-popover"
      style={{ left: menu.position.x, top: menu.position.y }}
    >
      <MenuButton onClick={handleCopy} icon={<Copy className="size-4" />} label={t('chat.copyLink')} />
      <MenuButton
        onClick={handleOpen}
        icon={<ExternalLink className="size-4" />}
        label={t('chat.openInBrowser')}
      />
    </div>
  )
}
