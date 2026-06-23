import { useTranslation } from 'react-i18next'
import { Ban, Pencil, Trash2, UserPlus } from 'lucide-react'
import { OverflowMenu, type OverflowMenuItem } from '../OverflowMenu'

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

  const items: OverflowMenuItem[] = []

  if (isInRoster) {
    items.push({ key: 'rename', label: t('contacts.rename'), icon: Pencil, onClick: onRename })
  }
  if (canAdd) {
    items.push({ key: 'add', label: t('contacts.addToContacts'), icon: UserPlus, onClick: onAdd })
  }
  if (isBlocked) {
    items.push({ key: 'unblock', label: t('contacts.unblockUser'), icon: Ban, onClick: onUnblock })
  } else {
    items.push({ key: 'block', label: t('contacts.blockUser'), icon: Ban, onClick: onBlock, danger: true })
  }
  if (isInRoster) {
    items.push({ key: 'remove', label: t('contacts.removeFromRoster'), icon: Trash2, onClick: onRemove, danger: true })
  }

  return <OverflowMenu ariaLabel={t('contacts.actionsMenu')} items={items} />
}
