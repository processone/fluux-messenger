import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { type Contact, type IdentityTrustDecision, type PeerIdentity, type ProfileDetails, useBlocking, useXMPPContext } from '@fluux/sdk'
import { useBlockingStore, useConnectionStore, useLastActivity } from '@fluux/sdk/react'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'
import { getTranslatedStatusText } from '@/utils/statusText'
import { useWindowDrag } from '@/hooks'
import { useConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { useToastStore } from '@/stores/toastStore'
import { useContactSecurityRequestStore } from '@/stores/contactSecurityRequestStore'
import { useConversationPlaintextOverrideStore } from '@/stores/conversationPlaintextOverrideStore'
import { ConfirmDialog } from './ConfirmDialog'
import { VerifyPeerDialog } from './VerifyPeerDialog'
import { ContactActionsMenu } from './contact-profile/ContactActionsMenu'
import { ContactProfileHero } from './contact-profile/ContactProfileHero'
import { ContactProfileGrid } from './contact-profile/ContactProfileGrid'
import { ContactSecurityDetail } from './contact-profile/ContactSecurityDetail'

interface ContactProfileViewProps {
  contact: Contact
  onStartConversation: () => void
  onRemoveContact: () => void
  onRenameContact: (name: string) => Promise<void>
  onFetchNickname: (jid: string) => Promise<string | null>
  onFetchProfileDetails?: (jid: string) => Promise<ProfileDetails | null>
  onAddContact?: () => void
  onBack?: () => void
  /** Whether the contact is in the user's roster (enables rename/remove actions) */
  isInRoster?: boolean
}

type PendingConfirm = 'remove' | 'block' | 'revokeVerify' | null

export function ContactProfileView({
  contact,
  onStartConversation,
  onRemoveContact,
  onRenameContact,
  onAddContact,
  onFetchNickname,
  onFetchProfileDetails,
  onBack,
  isInRoster = true,
}: ContactProfileViewProps) {
  const { t } = useTranslation()
  const connectionStatus = useConnectionStore((s) => s.status)
  const ownJid = useConnectionStore((s) => s.jid)
  const forceOffline = connectionStatus !== 'online'
  const { dragRegionProps } = useWindowDrag()

  const [securityOpen, setSecurityOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(contact.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null)
  const [showVerifyDialog, setShowVerifyDialog] = useState(false)
  // The key a dialog opened for. A decision is sent for it, so if the contact's keys changed
  // meanwhile the SDK refuses it and the person sees why, rather than the dialog doing nothing.
  const [trustTarget, setTrustTarget] = useState<{ protocolId: string; identityId: string; fingerprint: string } | null>(null)
  const [pepNickname, setPepNickname] = useState<string | null>(null)
  const [details, setDetails] = useState<ProfileDetails | null>(null)

  const { blockJid, unblockJid } = useBlocking()
  const isBlocked = useBlockingStore((s) => s.blockedJids.has(contact.jid))
  const { client } = useXMPPContext()
  const encryptionState = useConversationEncryptionState(contact.jid, 'chat')
  const setForcedPlaintext = useConversationPlaintextOverrideStore((s) => s.setForcedPlaintext)
  const addToast = useToastStore((s) => s.addToast)
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null)

  /** Read the own fingerprint when Verify opens, so a replaced or recovered key never shows a stale code. */
  const openVerify = async (target: { protocolId: string; identityId: string; fingerprint: string }) => {
    setTrustTarget(target)
    setOwnFingerprint((await client.e2ee?.getOwnFingerprint(target.protocolId)) ?? null)
    setShowVerifyDialog(true)
  }

  /**
   * Record a trust decision for one key; the SDK says whether the protocol accepts it.
   * A failure is shown to the person, including a decision for a key the contact no longer has.
   */
  const decideTrust = async (
    decision: IdentityTrustDecision,
    target: { protocolId: string; identityId: string } | null = trustTarget,
  ) => {
    if (!target) return
    try {
      await client.e2ee?.setIdentityTrust(target.protocolId, contact.jid, target.identityId, decision)
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : String(err))
    }
  }

  /** A button on a key's row in the Security tab. Verifying and removing a verification ask first. */
  const handleDecide = (protocolId: string, identity: PeerIdentity, decision: IdentityTrustDecision) => {
    const target = { protocolId, identityId: identity.id, fingerprint: identity.fingerprint }
    if (decision === 'verified') {
      void openVerify(target)
    } else if (decision === 'tofu' && identity.trust === 'verified') {
      setTrustTarget(target)
      setPendingConfirm('revokeVerify')
    } else {
      void decideTrust(decision, target)
    }
  }

  // Lazily query last activity for offline roster contacts
  useLastActivity(
    isInRoster && !forceOffline && contact.presence === 'offline' ? contact.jid : null
  )

  const presenceColor = forceOffline ? APP_OFFLINE_PRESENCE_COLOR : PRESENCE_COLORS[contact.presence]
  const statusText = forceOffline ? t('presence.offline') : getTranslatedStatusText(contact, t)

  // Reset transient state when the displayed contact changes.
  useEffect(() => {
    setSecurityOpen(false)
    setEditName(contact.name)
    setIsEditing(false)
    setError(null)
    setPendingConfirm(null)
    setShowVerifyDialog(false)
    setTrustTarget(null)
    setPepNickname(null)
    setDetails(null)
  }, [contact.jid, contact.name])

  // A held-keys notice or the Forward dialog asked to review this contact's keys.
  const securityRequested = useContactSecurityRequestStore((s) => s.jid === contact.jid)
  const clearSecurityRequest = useContactSecurityRequestStore((s) => s.clearContactSecurityRequest)
  useEffect(() => {
    if (!securityRequested) return
    setSecurityOpen(true)
    clearSecurityRequest()
  }, [securityRequested, clearSecurityRequest])

  // PEP nickname fetch
  useEffect(() => {
    let cancelled = false
    void onFetchNickname(contact.jid)
      .then((nick) => {
        if (!cancelled && nick && nick !== contact.name) {
          setPepNickname(nick)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [contact.jid, contact.name, onFetchNickname])

  // Profile details fetch
  useEffect(() => {
    if (!onFetchProfileDetails) return
    let cancelled = false
    void onFetchProfileDetails(contact.jid)
      .then((result) => {
        if (!cancelled && result) setDetails(result)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [contact.jid, onFetchProfileDetails])

  const handleSaveEdit = async () => {
    const trimmedName = editName.trim()
    if (!trimmedName) {
      setError(t('contacts.nameCannotBeEmpty'))
      return
    }
    if (trimmedName === contact.name) {
      setIsEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onRenameContact(trimmedName)
      setIsEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contacts.failedToRename'))
    } finally {
      setSaving(false)
    }
  }

  const handleStartEdit = () => {
    setEditName(contact.name)
    setError(null)
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setEditName(contact.name)
    setError(null)
    setIsEditing(false)
  }

  const handleDisableEncryption = () => {
    setForcedPlaintext(contact.jid, true)
    client.e2ee?.setForcedPlaintext({ kind: 'direct', peer: contact.jid }, true)
  }

  const handleEnableEncryption = () => {
    setForcedPlaintext(contact.jid, false)
    client.e2ee?.setForcedPlaintext({ kind: 'direct', peer: contact.jid }, false)
    client.e2ee?.invalidateCapability(contact.jid)
  }

  const handleConfirm = async () => {
    if (pendingConfirm === 'remove') {
      onRemoveContact()
    } else if (pendingConfirm === 'block') {
      void blockJid(contact.jid)
    } else if (pendingConfirm === 'revokeVerify') {
      await decideTrust('tofu')
    }
    setPendingConfirm(null)
  }

  const confirmConfig = pendingConfirm === 'remove'
    ? {
        title: t('contacts.removeFromRoster'),
        message: t('contacts.removeConfirm', { name: contact.name }),
        confirmLabel: t('contacts.remove'),
      }
    : pendingConfirm === 'block'
      ? {
          title: t('contacts.blockUser'),
          message: t('contacts.blockConfirm', { name: contact.name }),
          confirmLabel: t('contacts.block'),
        }
      : pendingConfirm === 'revokeVerify'
        ? {
            title: t('contacts.encryption.removeVerification'),
            message: t('contacts.encryption.removeVerificationConfirm', { name: contact.name }),
            confirmLabel: t('contacts.encryption.removeVerification'),
          }
        : null

  return (
    <>
      <div className="h-full flex flex-col bg-fluux-chat">
        {/* Header */}
        <div
          className="h-14 px-4 flex items-center gap-2 border-b border-fluux-bg shadow-sm"
          {...dragRegionProps}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden tap-target"
              aria-label={t('common.back')}
            >
              <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
            </button>
          )}
          <h2 className="type-view-title text-fluux-text">{t('contacts.contact')}</h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto">
            <ContactProfileHero
              contact={contact}
              isInRoster={isInRoster}
              forceOffline={forceOffline}
              presenceColor={presenceColor}
              statusText={statusText}
              pepNickname={pepNickname}
              isEditing={isEditing}
              editName={editName}
              saving={saving}
              error={error}
              onEditNameChange={setEditName}
              onStartEdit={handleStartEdit}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              onStartConversation={onStartConversation}
              actionsSlot={
                <ContactActionsMenu
                  isInRoster={isInRoster}
                  isBlocked={isBlocked}
                  canAdd={!isInRoster && !!onAddContact}
                  onRename={handleStartEdit}
                  onRemove={() => setPendingConfirm('remove')}
                  onBlock={() => setPendingConfirm('block')}
                  onUnblock={() => unblockJid(contact.jid)}
                  onAdd={() => onAddContact?.()}
                />
              }
            />

            <ContactProfileGrid
              contact={contact}
              details={details}
              isInRoster={isInRoster}
              forceOffline={forceOffline}
              encryptionState={encryptionState}
              onOpenSecurity={() => setSecurityOpen(true)}
            />
          </div>
        </div>

        {securityOpen && (
          <ContactSecurityDetail
            state={encryptionState}
            onDecide={handleDecide}
            onDisableEncryption={handleDisableEncryption}
            onEnableEncryption={handleEnableEncryption}
            onClose={() => setSecurityOpen(false)}
          />
        )}
      </div>

      {confirmConfig && (
        <ConfirmDialog
          title={confirmConfig.title}
          message={confirmConfig.message}
          confirmLabel={confirmConfig.confirmLabel}
          onConfirm={() => void handleConfirm()}
          onCancel={() => setPendingConfirm(null)}
          variant="danger"
        />
      )}

      {showVerifyDialog && trustTarget?.fingerprint && ownJid && (
        <VerifyPeerDialog
          peerName={contact.name}
          peerJid={contact.jid}
          peerFingerprint={trustTarget.fingerprint}
          ownJid={ownJid}
          ownFingerprint={ownFingerprint}
          onConfirm={() => {
            void decideTrust('verified').then(() => setShowVerifyDialog(false))
          }}
          onCancel={() => setShowVerifyDialog(false)}
        />
      )}
    </>
  )
}
