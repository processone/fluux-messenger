import { useTranslation } from 'react-i18next'
import { ShieldCheck, X } from 'lucide-react'
import { useProtocolSwitchStore } from '@/stores/protocolSwitchStore'

interface OmemoSwitchNoticeProps {
  /** Bare JID of the peer this conversation is with. */
  peerJid: string
}

/**
 * Dismissible callout rendered above the message list when a 1:1
 * conversation's active encryption protocol has just switched from OpenPGP
 * to OMEMO. The store records the pending switch on selection; this notice
 * is the only consumer. Self-renders nothing when there's no pending notice
 * for the peer, so the unconditional mount is fine for tree stability.
 *
 * Mirrors {@link KeyChangeBanner}'s yellow-callout recipe exactly — no new
 * design tokens.
 */
export function OmemoSwitchNotice({ peerJid }: OmemoSwitchNoticeProps) {
  const { t } = useTranslation()
  const pending = useProtocolSwitchStore((s) => s.pendingNotice(peerJid))

  if (!pending) return null

  return (
    <div
      role="status"
      className="mx-1 mt-1 mb-2 flex items-start gap-2 px-3 py-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10"
    >
      <ShieldCheck className="size-4 text-fluux-yellow flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fluux-text leading-snug">
          {t('chat.encryption.omemoSwitchNotice.body')}
        </p>
      </div>
      <button
        onClick={() => useProtocolSwitchStore.getState().dismiss(peerJid)}
        aria-label={t('common.close')}
        className="flex-shrink-0 p-0.5 text-fluux-muted hover:text-fluux-text rounded transition-colors tap-target"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
