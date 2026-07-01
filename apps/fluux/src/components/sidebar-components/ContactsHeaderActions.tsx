import { useTranslation } from 'react-i18next'
import { Plus, Ban } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { OverflowMenu, type OverflowMenuItem } from '../OverflowMenu'
import { SIDEBAR_HEADER_ICON_BTN } from './types'

interface ContactsHeaderActionsProps {
  /** Open the Add Contact modal. */
  onAddContact: () => void
  /** Navigate to the Blocked Users settings category. */
  onOpenBlocked: () => void
}

/**
 * Contacts tab header actions: an Add Contact create button followed by a `⋮`
 * overflow menu holding the Blocked Users management action.
 */
export function ContactsHeaderActions({ onAddContact, onOpenBlocked }: ContactsHeaderActionsProps) {
  const { t } = useTranslation()
  const items: OverflowMenuItem[] = [
    { key: 'blocked', label: t('sidebar.blockedUsers'), icon: Ban, onClick: onOpenBlocked },
  ]
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip content={t('sidebar.addContact')} position="bottom">
        <button
          type="button"
          onClick={onAddContact}
          aria-label={t('sidebar.addContact')}
          className={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
        >
          <Plus className="size-5" />
        </button>
      </Tooltip>
      <OverflowMenu
        ariaLabel={t('common.options')}
        items={items}
        buttonClassName={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
      />
    </div>
  )
}
