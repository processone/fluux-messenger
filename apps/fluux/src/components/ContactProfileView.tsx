import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { type Contact, type VCardInfo, useBlocking, useXMPPContext } from '@fluux/sdk'
import { useBlockingStore, useConnectionStore, useLastActivity } from '@fluux/sdk/react'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'
import { getTranslatedStatusText } from '@/utils/statusText'
import { useWindowDrag } from '@/hooks'
import { useConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useConversationPlaintextOverrideStore } from '@/stores/conversationPlaintextOverrideStore'
import { ConfirmDialog } from './ConfirmDialog'
import { VerifyPeerDialog } from './VerifyPeerDialog'
import { ContactActionsMenu } from './contact-profile/ContactActionsMenu'
import { ContactProfileHero } from './contact-profile/ContactProfileHero'
import { ContactProfileTabs, type ContactProfileTab } from './contact-profile/ContactProfileTabs'
import { ProfileTab } from './contact-profile/tabs/ProfileTab'
import { SecurityTab } from './contact-profile/tabs/SecurityTab'

interface ContactProfileViewProps {
  contact: Contact
  onStartConversation: () => void
  onRemoveContact: () => void
  onRenameContact: (name: string) => Promise<void>
  onFetchNickname: (jid: string) => Promise<string | null>
  onFetchVCard?: (jid: string) => Promise<VCardInfo | null>
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
  onFetchVCard,
  onBack,
  isInRoster = true,
}: ContactProfileViewProps) {
  const { t } = useTranslation()
  const connectionStatus = useConnectionStore((s) => s.status)
  const ownJid = useConnectionStore((s) => s.jid)
  const forceOffline = connectionStatus !== 'online'
  const { titleBarClass, dragRegionProps } = useWindowDrag()

  const [activeTab, setActiveTab] = useState<ContactProfileTab>('profile')
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(contact.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null)
  const [showVerifyDialog, setShowVerifyDialog] = useState(false)
  const [pepNickname, setPepNickname] = useState<string | null>(null)
  const [vcard, setVcard] = useState<VCardInfo | null>(null)

  const { blockJid, unblockJid } = useBlocking()
  const isBlocked = useBlockingStore((s) => s.blockedJids.has(contact.jid))
  const { client } = useXMPPContext()
  const encryptionState = useConversationEncryptionState(contact.jid, 'chat')
  const setVerified = useVerifiedPeerKeysStore((s) => s.setVerified)
  const clearVerified = useVerifiedPeerKeysStore((s) => s.clearVerified)
  const setForcedPlaintext = useConversationPlaintextOverrideStore((s) => s.setForcedPlaintext)
  const plugin = client.e2ee?.getPlugin('openpgp') as
    | { getOwnFingerprint?: () => string | null }
    | null
    | undefined
  const ownFingerprint = plugin?.getOwnFingerprint?.() ?? null

  // Lazily query last activity for offline roster contacts
  useLastActivity(
    isInRoster && !forceOffline && contact.presence === 'offline' ? contact.jid : null
  )

  const presenceColor = forceOffline ? APP_OFFLINE_PRESENCE_COLOR : PRESENCE_COLORS[contact.presence]
  const statusText = forceOffline ? t('presence.offline') : getTranslatedStatusText(contact, t)

  // Reset transient state when the displayed contact changes.
  useEffect(() => {
    setActiveTab('profile')
    setEditName(contact.name)
    setIsEditing(false)
    setError(null)
    setPendingConfirm(null)
    setShowVerifyDialog(false)
    setPepNickname(null)
    setVcard(null)
  }, [contact.jid, contact.name])

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

  // vCard fetch
  useEffect(() => {
    if (!onFetchVCard) return
    let cancelled = false
    void onFetchVCard(contact.jid)
      .then((result) => {
        if (!cancelled && result) setVcard(result)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [contact.jid, onFetchVCard])

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

  const handleConfirm = () => {
    if (pendingConfirm === 'remove') {
      onRemoveContact()
    } else if (pendingConfirm === 'block') {
      void blockJid(contact.jid)
    } else if (pendingConfirm === 'revokeVerify') {
      clearVerified(contact.jid)
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
          className={`h-14 ${titleBarClass} px-4 flex items-center gap-2 border-b border-fluux-bg shadow-sm`}
          {...dragRegionProps}
        >
          {onBack && (
            <button
              onClick={onBack}
              className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden"
              aria-label={t('common.back')}
            >
              <ArrowLeft className="w-5 h-5 text-fluux-muted rtl-mirror" />
            </button>
          )}
          <h2 className="font-semibold text-fluux-text">{t('contacts.contact')}</h2>
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

            <ContactProfileTabs
              active={activeTab}
              onChange={setActiveTab}
              encryptionState={encryptionState}
            />

            <div
              role="tabpanel"
              id={`contact-tab-panel-${activeTab}`}
              aria-labelledby={`contact-tab-${activeTab}`}
            >
              {activeTab === 'profile' && (
                <ProfileTab contact={contact} vcard={vcard} forceOffline={forceOffline} />
              )}
              {activeTab === 'security' && (
                <SecurityTab
                  state={encryptionState}
                  onVerify={() => setShowVerifyDialog(true)}
                  onRequestRevoke={() => setPendingConfirm('revokeVerify')}
                  onDisableEncryption={handleDisableEncryption}
                  onEnableEncryption={handleEnableEncryption}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {confirmConfig && (
        <ConfirmDialog
          title={confirmConfig.title}
          message={confirmConfig.message}
          confirmLabel={confirmConfig.confirmLabel}
          onConfirm={handleConfirm}
          onCancel={() => setPendingConfirm(null)}
          variant="danger"
        />
      )}

      {showVerifyDialog && encryptionState.kind === 'encrypted' && ownJid && (
        <VerifyPeerDialog
          peerName={contact.name}
          peerJid={contact.jid}
          peerFingerprint={encryptionState.fingerprint}
          ownJid={ownJid}
          ownFingerprint={ownFingerprint}
          onConfirm={(fingerprint) => {
            setVerified(contact.jid, fingerprint)
            setShowVerifyDialog(false)
          }}
          onCancel={() => setShowVerifyDialog(false)}
        />
      )}
    </>
  )
}
