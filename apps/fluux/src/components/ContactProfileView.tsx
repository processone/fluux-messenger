import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { type Contact, type PeerIdentity, type VCardInfo, useBlocking, useXMPPContext } from '@fluux/sdk'
import { useBlockingStore, useConnectionStore, useLastActivity } from '@fluux/sdk/react'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'
import { getTranslatedStatusText } from '@/utils/statusText'
import { useWindowDrag } from '@/hooks'
import { useConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { useApplyIdentityTrust } from '@/hooks/useApplyIdentityTrust'
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
  onFetchVCard?: (jid: string) => Promise<VCardInfo | null>
  onAddContact?: () => void
  onBack?: () => void
  /** Whether the contact is in the user's roster (enables rename/remove actions) */
  isInRoster?: boolean
}

type PendingConfirm = 'remove' | 'block' | null

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
  const { dragRegionProps } = useWindowDrag()

  const [securityOpen, setSecurityOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(contact.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null)
  const [pepNickname, setPepNickname] = useState<string | null>(null)
  const [vcard, setVcard] = useState<VCardInfo | null>(null)

  const { blockJid, unblockJid } = useBlocking()
  const isBlocked = useBlockingStore((s) => s.blockedJids.has(contact.jid))
  const { client } = useXMPPContext()
  const encryptionState = useConversationEncryptionState(contact.jid, 'chat')
  const setForcedPlaintext = useConversationPlaintextOverrideStore((s) => s.setForcedPlaintext)
  // Shared verify/revoke apply (see useApplyIdentityTrust): awaits the
  // plugin call, shows a success toast only once it resolves, and surfaces
  // an error toast on rejection instead of leaving an unhandled promise
  // rejection (previously the verify dialog just stayed open silently on a
  // failed write — see Phase B1 final-review Finding 1). Same hook ChatView
  // uses for its chat-header verify/revoke, so the two entry points can't
  // drift apart again.
  const applyIdentityTrust = useApplyIdentityTrust()

  const handleDisableEncryption = useCallback(() => {
    setForcedPlaintext(contact.jid, true)
    client.e2ee?.setForcedPlaintext({ kind: 'direct', peer: contact.jid }, true)
  }, [client.e2ee, contact.jid, setForcedPlaintext])

  // Resolve the plugin driving THIS conversation and, if it exposes the
  // per-identity trait, build the shared identities handle. OMEMO and OpenPGP
  // both flow through this now.
  const activeProtocol =
    encryptionState.kind === 'encrypted' ? (encryptionState.protocolId ?? 'openpgp') : null
  const identityPlugin = activeProtocol
    ? (client.e2ee?.getPlugin(activeProtocol) as {
        listPeerIdentities?: (peer: string) => Promise<PeerIdentity[]>
        getOwnFingerprint: () => string | null | Promise<string | null>
        setIdentityTrust?: (peer: string, id: string, decision: 'verified' | 'untrusted') => Promise<void>
      } | null | undefined)
    : null

  const [verifyDevice, setVerifyDevice] = useState<PeerIdentity | null>(null)
  const [dialogOwnFp, setDialogOwnFp] = useState<string | null>(null)
  const [identityReloadKey, setIdentityReloadKey] = useState(0)

  // Memoized so SecurityTab's fetch effect (which depends on the whole
  // `identities` object) doesn't refetch + flash its loading spinner on
  // every unrelated parent re-render — only when the plugin, target peer,
  // or an explicit reload actually changes.
  const identitiesProp = useMemo(() => {
    if (!identityPlugin?.listPeerIdentities || !identityPlugin.setIdentityTrust) return null
    const setTrust = identityPlugin.setIdentityTrust.bind(identityPlugin)
    const isOmemo = activeProtocol === 'omemo:2'
    return {
      listPeerIdentities: identityPlugin.listPeerIdentities.bind(identityPlugin),
      rowLabel: (id: PeerIdentity) =>
        isOmemo
          ? t('contacts.encryption.identity.deviceLabel', { id: id.id })
          : t('contacts.encryption.identity.openpgpKeyLabel'),
      onVerifyDevice: (identity: PeerIdentity) => {
        void Promise.resolve(identityPlugin.getOwnFingerprint()).then((fp) => {
          setDialogOwnFp(fp)
          setVerifyDevice(identity)
        })
      },
      onRevokeDevice: async (identity: PeerIdentity) => {
        await setTrust(contact.jid, identity.id, 'untrusted')
        setIdentityReloadKey((n) => n + 1)
      },
      reloadKey: identityReloadKey,
      // OpenPGP keeps its "disable for contact" affordance; OMEMO unchanged (unset).
      showDisableButton: activeProtocol === 'openpgp',
      onDisableEncryption: handleDisableEncryption,
    }
  }, [identityPlugin, activeProtocol, contact.jid, identityReloadKey, t, handleDisableEncryption])

  // Used by the shared `VerifyPeerDialog` confirm handler below to persist
  // the trust decision once the user confirms a match for a device/key
  // surfaced through `identitiesProp.onVerifyDevice`.
  const setIdentityTrust = identityPlugin?.setIdentityTrust?.bind(identityPlugin)

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
    setPepNickname(null)
    setVcard(null)
    setVerifyDevice(null)
    setDialogOwnFp(null)
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
              onClick={onBack}
              className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden tap-target"
              aria-label={t('common.back')}
            >
              <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
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

            <ContactProfileGrid
              contact={contact}
              vcard={vcard}
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
            peerJid={contact.jid}
            identities={identitiesProp}
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
          onConfirm={handleConfirm}
          onCancel={() => setPendingConfirm(null)}
          variant="danger"
        />
      )}

      {verifyDevice && setIdentityTrust && ownJid && (
        <VerifyPeerDialog
          peerName={contact.name}
          peerJid={contact.jid}
          peerFingerprint={verifyDevice.fingerprint}
          ownJid={ownJid}
          ownFingerprint={dialogOwnFp}
          alreadyVerified={verifyDevice.trust === 'verified'}
          onConfirm={() => {
            const identityId = verifyDevice.id
            setVerifyDevice(null)
            void applyIdentityTrust(
              () => identityPlugin,
              contact.jid,
              identityId,
              'verified',
              'chat.verifyPeer.confirmSuccess',
              'chat.verifyPeer.confirmFailed',
            ).then((ok) => {
              if (ok) setIdentityReloadKey((n) => n + 1)
            })
          }}
          onCancel={() => setVerifyDevice(null)}
        />
      )}
    </>
  )
}
