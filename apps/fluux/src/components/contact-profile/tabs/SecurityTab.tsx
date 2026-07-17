import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Shield, ShieldAlert, ShieldCheck, ShieldOff, ShieldX } from 'lucide-react'
import type { PeerIdentity } from '@fluux/sdk'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { trustVisual, trustStateVisual, trustLabel } from '@/e2ee/trustVisual'

interface SecurityTabProps {
  state: ConversationEncryptionState
  onEnableEncryption: () => void
  /** Present when a per-identity handle is available for this conversation. */
  peerJid?: string
  identities?: {
    listPeerIdentities: (peer: string) => Promise<PeerIdentity[]>
    onVerifyDevice: (identity: PeerIdentity) => void
    onRevokeDevice: (identity: PeerIdentity) => Promise<void>
    reloadKey?: number
    /** Protocol-appropriate row label. OMEMO: `(id) => t('…deviceLabel',{id})`; OpenPGP: `() => t('…openpgpKeyLabel')`. */
    rowLabel: (identity: PeerIdentity) => string
    /** OpenPGP sets this to keep its "disable for contact" affordance; OMEMO leaves it unset. */
    showDisableButton?: boolean
    onDisableEncryption?: () => void
  } | null
}

export function SecurityTab({
  state,
  onEnableEncryption,
  peerJid,
  identities,
}: SecurityTabProps) {
  const { t } = useTranslation()

  return (
    <div className="px-4 py-4 md:px-6 md:py-5">
      <div className="space-y-3 max-w-md mx-auto">
        {state.kind === 'checking' && (
          <ExplanationPanel
            icon={<Loader2 className="size-5 text-fluux-muted animate-spin flex-shrink-0" />}
            title={t('chat.encryption.checking')}
            tone="neutral"
          />
        )}

        {state.kind === 'blocked' && (
          <ExplanationPanel
            icon={<ShieldAlert className={`size-5 ${trustVisual('keyChanged').colorClass} flex-shrink-0`} />}
            title={t('chat.encryption.blocked')}
            tone="warning"
          />
        )}

        {state.kind === 'needsDeviceVerification' && (
          <ExplanationPanel
            icon={<ShieldAlert className={`size-5 ${trustStateVisual('untrusted').colorClass} flex-shrink-0`} />}
            title={t('contacts.encryption.needsVerification.title')}
            description={t('contacts.encryption.needsVerification.description')}
            tone="danger"
          />
        )}

        {state.kind === 'rejected' && (
          <>
            <ExplanationPanel
              icon={<ShieldX className={`size-5 ${trustVisual('rejected').colorClass} flex-shrink-0`} />}
              title={t('contacts.encryption.rejectedTitle')}
              description={t('contacts.encryption.rejectedDescription')}
              tone="danger"
            />
            <div className="space-y-2">
              {state.reasons.map((r, i) => (
                <div key={i} className="rounded-lg bg-fluux-bg/40 px-3 py-2">
                  <div className="text-xs font-medium text-fluux-text">
                    {t(`chat.encryption.rejectionCode.${r.code}`)}
                  </div>
                  <code className="block text-xs font-mono text-fluux-muted mt-0.5 break-all">
                    {r.detail}
                  </code>
                </div>
              ))}
            </div>
          </>
        )}

        {state.kind === 'unsupported' && (
          <ExplanationPanel
            icon={<ShieldOff className="size-5 text-fluux-muted flex-shrink-0" />}
            title={t('contacts.encryption.notAvailableTitle')}
            description={t('contacts.encryption.notAvailableDescription')}
            tone="neutral"
          />
        )}

        {state.kind === 'plaintextForced' && (
          <>
            <ExplanationPanel
              icon={<ShieldOff className="size-5 text-fluux-muted flex-shrink-0" />}
              title={t('contacts.encryption.disabledByYouTitle')}
              description={t('contacts.encryption.disabledByYouDescription')}
              tone="neutral"
            />
            <button
              type="button"
              onClick={onEnableEncryption}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-border rounded-lg transition-colors text-sm min-h-[44px]"
            >
              <Shield className="size-4" />
              {t('chat.encryption.enableEncryption')}
            </button>
          </>
        )}

        {state.kind === 'disabled' && (
          <ExplanationPanel
            icon={<ShieldOff className="size-5 text-fluux-muted flex-shrink-0" />}
            title={t('contacts.encryption.unavailableNowTitle')}
            description={t('contacts.encryption.unavailableNowDescription')}
            tone="neutral"
          />
        )}

        {state.kind === 'encrypted' && identities && peerJid && (
          <PeerIdentityList peerJid={peerJid} identities={identities} />
        )}
      </div>
    </div>
  )
}

interface ExplanationPanelProps {
  icon: React.ReactNode
  title: string
  description?: string
  tone: 'success' | 'neutral' | 'warning' | 'danger'
}

function ExplanationPanel({ icon, title, description, tone }: ExplanationPanelProps) {
  const bg =
    tone === 'success'
      ? 'bg-green-500/10'
      : tone === 'danger'
        ? 'bg-red-500/10'
        : tone === 'warning'
          ? 'bg-yellow-500/10'
          : 'bg-fluux-bg/40'
  const titleColor =
    tone === 'danger'
      ? 'text-fluux-error'
      : tone === 'warning'
        ? 'text-fluux-yellow'
        : 'text-fluux-text'
  return (
    <div className={`flex items-start gap-3 px-3 py-3 rounded-lg ${bg}`}>
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${titleColor}`}>{title}</div>
        {description && (
          <p className="text-xs text-fluux-muted mt-1 leading-relaxed">{description}</p>
        )}
      </div>
    </div>
  )
}

function PeerIdentityList({
  peerJid,
  identities,
}: {
  peerJid: string
  identities: NonNullable<SecurityTabProps['identities']>
}) {
  const { t } = useTranslation()
  const [peerIdentities, setPeerIdentities] = useState<PeerIdentity[] | null>(null)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setPeerIdentities(null)
    setError(false)
    void identities
      .listPeerIdentities(peerJid)
      .then((list) => {
        if (!cancelled) setPeerIdentities(list)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
    // reload (local) + identities.reloadKey (parent) both force a refetch.
  }, [peerJid, identities, reload, identities.reloadKey])

  if (error) {
    return (
      <div className="space-y-2">
        <ExplanationPanel
          icon={<ShieldX className={`size-5 ${trustVisual('rejected').colorClass} flex-shrink-0`} />}
          title={t('contacts.encryption.identity.loadError')}
          tone="danger"
        />
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-border rounded-lg transition-colors text-sm min-h-[44px]"
        >
          {t('contacts.encryption.identity.retry')}
        </button>
      </div>
    )
  }

  if (peerIdentities === null) {
    return (
      <ExplanationPanel
        icon={<Loader2 className="size-5 text-fluux-muted animate-spin flex-shrink-0" />}
        title={t('contacts.encryption.identity.loading')}
        tone="neutral"
      />
    )
  }

  const verifiedCount = peerIdentities.filter((i) => i.trust === 'verified').length

  return (
    <div className="space-y-2">
      <div className="text-xs text-fluux-muted px-1">
        {t('contacts.encryption.identity.summary', { count: peerIdentities.length, verified: verifiedCount })}
      </div>
      {peerIdentities.map((id) => {
        const visual = trustStateVisual(id.trust)
        const hasKey = id.fingerprint !== ''
        return (
          <div key={id.id} className="rounded-lg bg-fluux-bg/40 px-3 py-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-fluux-text">
                {identities.rowLabel(id)}
              </span>
              <span className={`inline-flex items-center gap-1 text-xs ${visual.colorClass}`}>
                {id.trust === 'verified' ? <ShieldCheck className="size-3.5" /> : <Shield className="size-3.5" />}
                {t(trustLabel(id.trust))}
              </span>
            </div>
            <code className="block text-[11px] font-mono text-fluux-muted break-all leading-relaxed">
              {hasKey ? formatFingerprint(id.fingerprint) : t('contacts.encryption.identity.noKeyYet')}
            </code>
            <div className="flex gap-2">
              {id.trust === 'verified' ? (
                <button
                  type="button"
                  data-testid={`omemo-revoke-${id.id}`}
                  onClick={() =>
                    void identities
                      .onRevokeDevice(id)
                      .then(() => setReload((n) => n + 1))
                      .catch(() => setError(true))
                  }
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-fluux-red/10 hover:bg-fluux-red/20 text-fluux-error border border-fluux-red rounded-lg transition-colors text-xs min-h-[36px]"
                >
                  <ShieldOff className="size-3.5" />
                  {t('contacts.encryption.identity.revoke')}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid={`omemo-verify-${id.id}`}
                  disabled={!hasKey}
                  onClick={() => identities.onVerifyDevice(id)}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-border rounded-lg transition-colors text-xs min-h-[36px] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ShieldCheck className="size-3.5" />
                  {t('contacts.encryption.identity.verify')}
                </button>
              )}
              {id.trust === 'untrusted' && (
                <span className={`flex items-center gap-1 text-xs ${trustStateVisual('untrusted').colorClass}`}>
                  <ShieldAlert className="size-3.5" />
                </span>
              )}
            </div>
          </div>
        )
      })}
      {identities.showDisableButton && (
        <button
          type="button"
          onClick={() => identities.onDisableEncryption?.()}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-muted border border-fluux-border rounded-lg transition-colors text-sm min-h-[44px]"
        >
          <ShieldOff className="size-4" />
          {t('contacts.encryption.disableForContact')}
        </button>
      )}
    </div>
  )
}

export function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}
