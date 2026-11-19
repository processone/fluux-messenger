import { useTranslation } from 'react-i18next'
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

interface HeldKeysBannerProps {
  /** The conversation's encryption state. */
  state: ConversationEncryptionState
  /** The contact's display name. */
  peerName: string
  /** Open the contact's Security details, where each key can be trusted. */
  onReview?: () => void
}

type Notice = 'partial' | 'all' | 'pendingPartial' | 'pendingAll' | 'distrusted'

/**
 * Why some or all of a contact's keys receive no messages.
 *
 * - `partial`: the contact is verified and announced a new key; it waits for
 *   a decision while the other keys keep receiving messages.
 * - `all`: every key the contact announces waits for a decision, so nothing
 *   can be sent.
 * - `pendingPartial`, `pendingAll`: the same, where every waiting key waits
 *   for the trust data of an earlier version to be moved, which the app tries
 *   again on its own.
 * - `distrusted`: the person refused every key the contact announces, so
 *   nothing can be sent.
 */
export function heldKeysNotice(state: ConversationEncryptionState): Notice | null {
  const onlyPending = (s: { waiting?: number; pending?: number }) => (s.pending ?? 0) > 0 && s.pending === s.waiting
  if (state.kind === 'encrypted' && (state.waiting ?? 0) > 0) return onlyPending(state) ? 'pendingPartial' : 'partial'
  if (state.kind === 'unsupported' && state.needsDecision) return onlyPending(state) ? 'pendingAll' : 'all'
  if (state.kind === 'rejected' && state.distrusted) return 'distrusted'
  return null
}

/** Explains in the conversation why a contact's keys are held, with a way to review them. */
export function HeldKeysBanner({ state, peerName, onReview }: HeldKeysBannerProps) {
  const { t } = useTranslation()
  const notice = heldKeysNotice(state)
  if (!notice) return null

  return (
    <div
      role="alert"
      className="mx-1 mt-1 mb-2 flex items-start gap-2 px-3 py-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10"
    >
      <AlertTriangle className="size-4 text-fluux-yellow flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fluux-text leading-snug">
          {t(`chat.encryption.heldKeys.${notice}`, { name: peerName })}
        </p>
        {onReview && (
          <button
            type="button"
            onClick={onReview}
            className="flex items-center gap-1.5 mt-2 px-3 py-1 text-xs font-medium bg-fluux-hover text-fluux-text hover:bg-fluux-active rounded transition-colors"
          >
            <ShieldCheck className="size-3.5" />
            {t('chat.encryption.heldKeys.review')}
          </button>
        )}
      </div>
    </div>
  )
}
