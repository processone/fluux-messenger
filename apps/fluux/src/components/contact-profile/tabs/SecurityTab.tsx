import { useTranslation } from 'react-i18next'
import { Loader2, Shield, ShieldAlert, ShieldCheck, ShieldOff, ShieldX } from 'lucide-react'
import type { IdentityTrustDecision, PeerIdentity, PeerIdentityGroup } from '@fluux/sdk'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { trustVisual } from '@/e2ee/trustVisual'

export interface SecurityTabProps {
  state: ConversationEncryptionState
  /** A trust decision the person chose on one key's row. The SDK listed it in that key's `allowedDecisions`. */
  onDecide: (protocolId: string, identity: PeerIdentity, decision: IdentityTrustDecision) => void
  onDisableEncryption: () => void
  onEnableEncryption: () => void
}

export function SecurityTab({
  state,
  onDecide,
  onDisableEncryption,
  onEnableEncryption,
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

        {state.kind === 'rejected' && (
          <>
            <ExplanationPanel
              icon={<ShieldX className={`size-5 ${trustVisual('rejected').colorClass} flex-shrink-0`} />}
              title={t(state.distrusted ? 'contacts.encryption.distrustedTitle' : 'contacts.encryption.rejectedTitle')}
              description={t(state.distrusted ? 'contacts.encryption.distrustedDescription' : 'contacts.encryption.rejectedDescription')}
              tone="danger"
            />
            {state.groups && state.groups.length > 0 ? (
              <IdentityGroups groups={state.groups} onDecide={onDecide} />
            ) : state.distrusted ? null : (
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
            )}
          </>
        )}

        {state.kind === 'unsupported' && state.listError && <ListError retry={state.listError.retry} />}

        {state.kind === 'unsupported' && !state.listError && (
          <>
            <ExplanationPanel
              icon={<ShieldOff className="size-5 text-fluux-muted flex-shrink-0" />}
              title={state.needsDecision ? t('contacts.encryption.needsDecisionTitle') : t('contacts.encryption.notAvailableTitle')}
              description={state.needsDecision ? t('contacts.encryption.needsDecisionDescription') : t('contacts.encryption.notAvailableDescription')}
              tone="neutral"
            />
            {state.groups && <IdentityGroups groups={state.groups} onDecide={onDecide} />}
          </>
        )}

        {state.kind === 'keyLocked' && (
          <>
            <ExplanationPanel
              icon={<ShieldAlert className="size-5 text-fluux-muted flex-shrink-0" />}
              title={t('chat.encryption.keyLocked')}
              description={t('chat.encryption.keyLockedTooltip')}
              tone="neutral"
            />
            {state.listError && <ListError retry={state.listError.retry} />}
            {state.groups && <IdentityGroups groups={state.groups} locked onDecide={onDecide} />}
          </>
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

        {state.kind === 'encrypted' && (
          <>
            <ExplanationPanel
              icon={
                state.trust === 'verified' ? (
                  <ShieldCheck className={`size-5 ${trustVisual('verified').colorClass} flex-shrink-0`} />
                ) : (
                  <Shield className="size-5 text-fluux-muted flex-shrink-0" />
                )
              }
              title={
                state.trust === 'verified'
                  ? t('contacts.encryption.verified')
                  : t('contacts.encryption.tofu')
              }
              description={state.partlyVerified ? t('chat.encryption.unverifiedKeysetTooltip') : undefined}
              tone={state.trust === 'verified' ? 'success' : 'neutral'}
            />

            {state.listError && <ListError retry={state.listError.retry} />}
            <IdentityGroups groups={state.groups ?? []} onDecide={onDecide} />

            <button
              type="button"
              onClick={onDisableEncryption}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-muted border border-fluux-border rounded-lg transition-colors text-sm min-h-[44px]"
            >
              <ShieldOff className="size-4" />
              {t('contacts.encryption.disableForContact')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** The keys could not be read; nothing is wrong with the conversation's encryption itself. */
function ListError({ retry }: { retry: () => void }) {
  const { t } = useTranslation()
  return (
    <>
      <ExplanationPanel
        icon={<ShieldAlert className={`size-5 ${trustVisual('keyChanged').colorClass} flex-shrink-0`} />}
        title={t('contacts.encryption.listErrorTitle')}
        description={t('contacts.encryption.listErrorDescription')}
        tone="warning"
      />
      <button
        type="button"
        onClick={retry}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-border rounded-lg transition-colors text-sm min-h-[44px]"
      >
        {t('contacts.encryption.tryAgain')}
      </button>
    </>
  )
}

/** Every method's keys for the contact, whatever the conversation's own state. */
function IdentityGroups({
  groups,
  locked = false,
  onDecide,
}: {
  groups: PeerIdentityGroup[]
  /** The own key is locked: sending needs an unlock first. */
  locked?: boolean
  onDecide: SecurityTabProps['onDecide']
}) {
  return (
    <>
      {groups.map((group) => (
        <IdentityGroup key={group.protocolId} group={group} showInUse={groups.length > 1} locked={locked} onDecide={onDecide} />
      ))}
    </>
  )
}

interface IdentityGroupProps {
  group: PeerIdentityGroup
  /** Mark the method in use; only useful when the contact has more than one method. */
  showInUse: boolean
  locked: boolean
  onDecide: SecurityTabProps['onDecide']
}

/** One encryption method's keys for the contact, one row per key. */
function IdentityGroup({ group, showInUse, locked, onDecide }: IdentityGroupProps) {
  const { t } = useTranslation()
  return (
    <section aria-label={group.displayName} className="space-y-2">
      <h3 className="flex items-center gap-2 px-1 text-xs font-medium text-fluux-muted">
        {group.displayName}
        {showInUse && group.inUse && (
          <span className="rounded bg-fluux-bg/60 px-1.5 py-0.5 text-[11px] text-fluux-text">
            {t('contacts.encryption.methodInUse')}
          </span>
        )}
      </h3>
      {group.identities.map((identity) => (
        <IdentityRow key={identity.id} protocolId={group.protocolId} identity={identity} inUse={group.inUse} locked={locked} onDecide={onDecide} />
      ))}
    </section>
  )
}

function IdentityRow({
  protocolId,
  identity,
  inUse,
  locked,
  onDecide,
}: {
  protocolId: string
  identity: PeerIdentity
  /** False for a method the conversation would not use now. */
  inUse: boolean
  /** The own key is locked, so no message is sent until it is unlocked. */
  locked: boolean
  onDecide: SecurityTabProps['onDecide']
}) {
  const { t } = useTranslation()
  const visual = trustVisual(identity.trust)
  return (
    <div className="rounded-lg bg-fluux-bg/40 px-3 py-2 space-y-1.5" data-testid="identity-row">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs font-medium ${visual.colorClass}`}>
          {t(`contacts.encryption.keyTrust.${identity.trust}`)}
        </span>
        {identity.label && <span className="text-xs text-fluux-muted truncate">{identity.label}</span>}
      </div>
      {identity.fingerprint && (
        <code className="block text-xs font-mono text-fluux-text break-all leading-relaxed">
          {formatFingerprint(identity.fingerprint)}
        </code>
      )}
      <div className="text-xs text-fluux-muted">
        {identity.usedForEncryption
          ? t(
              !inUse
                ? 'contacts.encryption.wouldReceiveMessages'
                : locked
                  ? 'contacts.encryption.receivesWhenUnlocked'
                  : 'contacts.encryption.receivesMessages',
            )
          : `${t('contacts.encryption.receivesNoMessages')}${
              identity.notUsedReason ? `: ${t(`contacts.encryption.notUsedReason.${identity.notUsedReason}`)}` : ''
            }`}
      </div>
      {identity.problem && (
        <div className="text-xs">
          <div className="text-fluux-error">
            {t(`chat.encryption.rejectionCode.${identity.problem.code}`, { defaultValue: identity.problem.code })}
          </div>
          {identity.problem.detail && (
            <code className="block font-mono text-fluux-muted mt-0.5 break-all">{identity.problem.detail}</code>
          )}
        </div>
      )}
      {identity.allowedDecisions.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-1">
          {identity.allowedDecisions.map((decision) => (
            <DecisionButton
              key={decision}
              decision={decision}
              verified={identity.trust === 'verified'}
              onClick={() => onDecide(protocolId, identity, decision)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DecisionButton({
  decision,
  verified,
  onClick,
}: {
  decision: IdentityTrustDecision
  verified: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  const neutral = 'bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-border'
  const danger = 'bg-fluux-red/10 hover:bg-fluux-red/20 text-fluux-error border border-fluux-red'
  const config =
    decision === 'verified'
      ? { icon: <ShieldCheck className="size-4" />, label: t('contacts.encryption.verifyButton'), style: neutral }
      : decision === 'untrusted'
        ? { icon: <ShieldX className="size-4" />, label: t('contacts.encryption.distrustButton'), style: danger }
        : verified
          ? { icon: <ShieldOff className="size-4" />, label: t('contacts.encryption.removeVerification'), style: danger }
          : { icon: <Shield className="size-4" />, label: t('contacts.encryption.trustButton'), style: neutral }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-colors text-sm min-h-[44px] ${config.style}`}
    >
      {config.icon}
      {config.label}
    </button>
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

export function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}
