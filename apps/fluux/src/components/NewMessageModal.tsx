import { useTranslation } from 'react-i18next'
import { UserPlus, Users } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { ContactSelector } from './ContactSelector'

interface NewMessageModalProps {
  onClose: () => void
  onPick: (jid: string) => void
  onAddContact: () => void
  onManageContacts: () => void
}

export function NewMessageModal({ onClose, onPick, onAddContact, onManageContacts }: NewMessageModalProps) {
  const { t } = useTranslation()

  return (
    <ModalShell title={t('newMessage.title')} onClose={onClose} width="max-w-md" panelClassName="max-h-[90vh] flex flex-col">
      <div className="p-4 space-y-3 overflow-y-auto flex-1">
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={() => {}}
          onPick={(jid) => { onPick(jid); onClose() }}
          placeholder={t('newMessage.searchPlaceholder')}
        />

        <div className="border-t border-fluux-hover pt-2 space-y-1">
          <button
            type="button"
            onClick={() => { onAddContact() }}
            className="w-full px-3 py-2 text-start text-sm rounded hover:bg-fluux-hover flex items-center gap-2"
          >
            <UserPlus className="size-4 text-fluux-muted" />
            <span>{t('contacts.addContact')}</span>
          </button>
          <button
            type="button"
            onClick={() => { onManageContacts(); onClose() }}
            className="w-full px-3 py-2 text-start text-sm rounded hover:bg-fluux-hover flex items-center gap-2"
          >
            <Users className="size-4 text-fluux-muted" />
            <span>{t('newMessage.manageContacts')}</span>
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
