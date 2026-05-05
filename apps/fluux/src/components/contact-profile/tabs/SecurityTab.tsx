import { useTranslation } from 'react-i18next'
import { Loader2, Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

interface SecurityTabProps {
  state: ConversationEncryptionState
  onVerify: () => void
  onRequestRevoke: () => void
  onDisableEncryption: () => void
  onEnableEncryption: () => void
}

export function SecurityTab({
  state,
  onVerify,
  onRequestRevoke,
  onDisableEncryption,
  onEnableEncryption,
}: SecurityTabProps) {
  const { t } = useTranslation()

  return (
    <div className="px-4 py-4 md:px-6 md:py-5">
      <div className="space-y-3 max-w-md mx-auto">
        {state.kind === 'checking' && (
          <StatusRow
            icon={<Loader2 className="w-4 h-4 text-fluux-muted animate-spin flex-shrink-0" />}
            text={t('chat.encryption.checking')}
            tone="neutral"
          />
        )}

        {state.kind === 'blocked' && (
          <StatusRow
            icon={<ShieldAlert className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />}
            text={t('chat.encryption.blocked')}
            tone="warning"
          />
        )}

        {state.kind === 'plaintextForced' && (
          <>
            <StatusRow
              icon={<LockOpen className="w-4 h-4 text-fluux-muted flex-shrink-0" />}
              text={t('chat.encryption.plaintextForced')}
              tone="neutral"
            />
            <button
              type="button"
              onClick={onEnableEncryption}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-hover rounded-lg transition-colors text-sm min-h-[44px]"
            >
              <Lock className="w-4 h-4" />
              {t('chat.encryption.enableEncryption')}
            </button>
          </>
        )}

        {state.kind === 'unsupported' && (
          <StatusRow
            icon={<LockOpen className="w-4 h-4 text-fluux-muted flex-shrink-0" />}
            text={t('chat.encryption.plaintextForced')}
            tone="neutral"
          />
        )}

        {state.kind === 'disabled' && (
          <p className="text-sm text-fluux-muted text-center px-2">
            {t('contacts.encryption.sectionTitle')}
          </p>
        )}

        {state.kind === 'encrypted' && (
          <>
            <StatusRow
              icon={
                state.trust === 'verified' ? (
                  <ShieldCheck className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
                ) : (
                  <Lock className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                )
              }
              text={
                state.trust === 'verified'
                  ? t('contacts.encryption.verified')
                  : t('contacts.encryption.trusted')
              }
              tone={state.trust === 'verified' ? 'success' : 'neutral'}
            />

            <div>
              <label className="block text-xs text-fluux-muted mb-1 px-1">
                {t('contacts.encryption.fingerprintLabel')}
              </label>
              <div className="rounded-lg border border-fluux-hover bg-fluux-bg px-3 py-2">
                <code className="block text-xs font-mono text-fluux-text break-all leading-relaxed">
                  {formatFingerprint(state.fingerprint)}
                </code>
              </div>
            </div>

            {state.trust === 'unverified' && (
              <button
                type="button"
                onClick={onVerify}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-hover rounded-lg transition-colors text-sm min-h-[44px]"
              >
                <ShieldCheck className="w-4 h-4" />
                {t('contacts.encryption.verifyButton')}
              </button>
            )}

            {state.trust === 'verified' && (
              <button
                type="button"
                onClick={onRequestRevoke}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-red/10 hover:bg-fluux-red/20 text-fluux-red border border-fluux-red rounded-lg transition-colors text-sm min-h-[44px]"
              >
                <ShieldOff className="w-4 h-4" />
                {t('contacts.encryption.removeVerification')}
              </button>
            )}

            <button
              type="button"
              onClick={onDisableEncryption}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-muted border border-fluux-hover rounded-lg transition-colors text-sm min-h-[44px]"
            >
              <ShieldOff className="w-4 h-4" />
              {t('chat.encryption.disableEncryption')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function StatusRow({
  icon,
  text,
  tone,
}: {
  icon: React.ReactNode
  text: string
  tone: 'success' | 'neutral' | 'warning'
}) {
  const bg =
    tone === 'success'
      ? 'bg-green-500/10'
      : tone === 'warning'
        ? 'bg-yellow-500/10'
        : 'bg-fluux-bg'
  const textColor =
    tone === 'warning'
      ? 'text-yellow-700 dark:text-yellow-400'
      : 'text-fluux-text'
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${bg}`}>
      {icon}
      <span className={`text-sm ${textColor}`}>{text}</span>
    </div>
  )
}

export function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}
