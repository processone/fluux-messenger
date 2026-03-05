import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRoster } from '@fluux/sdk'
import { useModalInput } from '@/hooks'
import { ModalShell } from './ModalShell'

interface AddContactModalProps {
  onClose: () => void
}

export function AddContactModal({ onClose }: AddContactModalProps) {
  const { t } = useTranslation()
  const { addContact } = useRoster()
  const [jid, setJid] = useState('')
  const [nick, setNick] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const inputRef = useModalInput<HTMLInputElement>()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedJid = jid.trim()
    const trimmedNick = nick.trim()

    if (!trimmedJid) {
      setError(t('contacts.pleaseEnterJid'))
      return
    }

    // Basic JID validation
    if (!trimmedJid.includes('@')) {
      setError(t('contacts.invalidJidFormat'))
      return
    }

    setSending(true)
    try {
      await addContact(trimmedJid, trimmedNick || undefined)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contacts.failedToSendRequest'))
    } finally {
      setSending(false)
    }
  }

  return (
    <ModalShell title={t('contacts.addContact')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <div>
          <label htmlFor="contact-jid" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('contacts.jidLabel')}
          </label>
          <input
            ref={inputRef}
            id="contact-jid"
            type="text"
            value={jid}
            onChange={(e) => setJid(e.target.value)}
            placeholder={t('login.jidPlaceholder')}
            disabled={sending}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor="contact-nick" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('contacts.nicknameLabel')} <span className="font-normal normal-case">{t('contacts.nicknameOptional')}</span>
          </label>
          <input
            id="contact-nick"
            type="text"
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            placeholder={t('contacts.nicknamePlaceholder')}
            disabled={sending}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted disabled:opacity-50"
          />
        </div>

        {error && (
          <p className="text-sm text-fluux-red">{error}</p>
        )}
        <p className="text-xs text-fluux-muted">
          {t('contacts.subscriptionNote')}
        </p>

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
            disabled={sending || !jid.trim()}
            className="flex-1 px-4 py-2 text-white bg-fluux-brand rounded hover:bg-fluux-brand/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? t('contacts.sending') : t('contacts.addContact')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
