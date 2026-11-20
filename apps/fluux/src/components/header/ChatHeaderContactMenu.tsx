/** Pointer menu for a right-click on the contact in a 1:1 chat header: the same entries as the ⋯ menu. */
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Copy } from 'lucide-react'
import { MenuButton } from '../sidebar-components/SidebarListMenu'
import type { ContextMenuState } from '@/hooks/useContextMenu'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { copyToClipboard } from '@/utils/clipboard'
import type { OverflowEntry } from './HeaderOverflowKebab'

interface ChatHeaderContactMenuProps {
  menu: ContextMenuState
  entries: OverflowEntry[]
  selection: { text: string }
}

export function ChatHeaderContactMenu({ menu, entries, selection }: ChatHeaderContactMenuProps) {
  const { t } = useTranslation()
  useFocusTrap(menu.menuRef, { active: menu.isOpen })

  const run = (fn: () => void | Promise<void>) => { menu.close(); void fn() }
  const copySelection = () => run(() => copyToClipboard(selection.text))

  return createPortal(
    <div
      ref={menu.menuRef}
      role="menu"
      aria-label={t('contacts.actionsMenu')}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      // Pressing a row must not move focus off the menu or start a text selection on the page.
      onMouseDown={(e) => e.preventDefault()}
      // The system menu stays reachable with Shift.
      onContextMenu={(e) => {
        e.stopPropagation()
        if (!e.shiftKey) e.preventDefault()
      }}
      data-modal="true"
      className="fixed z-50 min-w-[220px] py-1 rounded-lg fluux-popover outline-none max-h-[calc(100dvh-1rem)] overflow-y-auto"
      style={{ left: menu.position.x, top: menu.position.y }}
    >
      {selection.text && (
        <>
          <MenuButton onClick={copySelection} icon={<Copy className="size-4" />} label={t('chat.selection.copy')} />
          <div className="my-1 border-t border-fluux-border" role="separator" />
        </>
      )}
      {entries.map((e) => {
        if (e.kind !== 'action') return null
        const Icon = e.icon
        return (
          <div key={e.key}>
            {e.separatorBefore && <div className="my-1 border-t border-fluux-border" role="separator" />}
            <MenuButton
              onClick={() => run(e.onSelect)}
              icon={<Icon className="size-4" />}
              label={e.label}
              variant={e.danger ? 'danger' : 'default'}
            />
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
