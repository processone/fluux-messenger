import { useState } from 'react'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import { type Contact } from '@fluux/sdk'
import { useModalInput } from '@/hooks'
import { ModalShell } from './ModalShell'

interface RenameContactModalProps {
  contact: Contact
  onRename: (name: string) => Promise<void>
  onClose: () => void
}

export function RenameContactModal({
  contact,
  onRename,
  onClose
}: RenameContactModalProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(contact.name)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useModalInput<HTMLInputElement>()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedName = name.trim()
    if (!trimmedName) {
      setError(t('contacts.pleaseEnterName'))
      return
    }

    if (trimmedName === contact.name) {
      onClose()
      return
    }

    setSaving(true)
    try {
      await onRename(trimmedName)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contacts.failedToRename'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title={t('contacts.renameContact')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <div>
          <label htmlFor="contact-name" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('contacts.displayName')}
          </label>
          <TextInput
            ref={inputRef}
            id="contact-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('contacts.enterName')}
            disabled={saving}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted disabled:opacity-50"
          />
        </div>

        <p className="text-xs text-fluux-muted truncate">
          {contact.jid}
        </p>

        {error && (
          <p className="text-sm text-fluux-red">{error}</p>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 text-fluux-text bg-fluux-bg rounded hover:bg-fluux-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="flex-1 px-4 py-2 text-fluux-text-on-accent bg-fluux-brand rounded hover:bg-fluux-brand/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
