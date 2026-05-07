import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, MoreVertical, Pencil, Trash2, UserPlus } from 'lucide-react'
import { useClickOutside } from '@/hooks/useClickOutside'

interface ContactActionsMenuProps {
  isInRoster: boolean
  isBlocked: boolean
  canAdd: boolean
  onRename: () => void
  onRemove: () => void
  onBlock: () => void
  onUnblock: () => void
  onAdd: () => void
}

export function ContactActionsMenu({
  isInRoster,
  isBlocked,
  canAdd,
  onRename,
  onRemove,
  onBlock,
  onUnblock,
  onAdd,
}: ContactActionsMenuProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useClickOutside(menuRef, () => setIsOpen(false), isOpen)

  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen])

  const close = () => setIsOpen(false)

  const items: Array<{ key: string; label: string; icon: typeof Pencil; onClick: () => void; danger?: boolean }> = []

  if (isInRoster) {
    items.push({ key: 'rename', label: t('contacts.rename'), icon: Pencil, onClick: () => { close(); onRename() } })
  }
  if (canAdd) {
    items.push({ key: 'add', label: t('contacts.addToContacts'), icon: UserPlus, onClick: () => { close(); onAdd() } })
  }
  if (isBlocked) {
    items.push({ key: 'unblock', label: t('contacts.unblockUser'), icon: Ban, onClick: () => { close(); onUnblock() } })
  } else {
    items.push({ key: 'block', label: t('contacts.blockUser'), icon: Ban, onClick: () => { close(); onBlock() }, danger: true })
  }
  if (isInRoster) {
    items.push({ key: 'remove', label: t('contacts.removeFromRoster'), icon: Trash2, onClick: () => { close(); onRemove() }, danger: true })
  }

  if (items.length === 0) return null

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-label={t('contacts.actionsMenu')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="p-2 rounded-lg text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
      >
        <MoreVertical className="w-5 h-5" />
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute end-0 mt-1 z-50 w-56 bg-fluux-sidebar border border-fluux-hover rounded-lg shadow-lg py-1"
        >
          {items.map(({ key, label, icon: Icon, onClick, danger }) => (
            <button
              key={key}
              role="menuitem"
              type="button"
              onClick={onClick}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-start text-sm transition-colors hover:bg-fluux-active ${danger ? 'text-fluux-red' : 'text-fluux-text'}`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
