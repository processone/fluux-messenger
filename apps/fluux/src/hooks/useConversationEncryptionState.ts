import { useCallback, useEffect, useState } from 'react'
import { useConnectionStatus, useXMPPContext } from '@fluux/sdk'
import type { ConversationSecurity, E2EEManager, PeerIdentity, PeerIdentityGroup, TrustState } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'

/** Why an identity or certificate cannot receive messages, as the SDK reports it. */
export interface EncryptionProblem {
  id: string
  code: string
  detail: string
}

/**
 * Per-conversation encryption status surfaced to the composer chip, the
 * header shield and the Security tab. The SDK computes it from the registered
 * protocols; the app holds no protocol branches.
 *
 * - `disabled`    — master toggle is off, we're not online, or the
 *                   conversation isn't a 1:1 chat (MUCs are not
 *                   E2EE-capable in this phase).
 * - `checking`    — waiting for the SDK to answer for this conversation.
 * - `encrypted`   — messages are encrypted. `trust` is the SDK's aggregate over
 *                   the keys that receive messages. `fingerprint` is the key
 *                   shown to the user (the one in use, or the first of several).
 *                   `isNew` marks a contact met recently and not verified;
 *                   `partlyVerified` a contact with a verified key whose
 *                   messages also go to a key that is not verified.
 *                   `canVerify` and `canClearVerification` say whether the
 *                   protocol accepts that decision for this contact now.
 * - `blocked`       — retired: no protocol produces it any more. Kept for the
 *                     surfaces that still draw it.
 * - `unsupported`   — no registered protocol can encrypt to this contact.
 *                     Composer falls back to plaintext. `needsDecision` marks a
 *                     contact whose keys all wait for the user's decision;
 *                     `listError` marks keys that could not be read, with a way
 *                     to ask again. `groups` lists the keys known meanwhile.
 * - `rejected`      — keys exist but none can receive messages; `reasons`
 *                     carries one entry per problem so the UI can explain.
 * - `plaintextForced` — user has explicitly disabled encryption for
 *                     this conversation.
 * - `keyLocked`     — encryption would be used, but the local private key is
 *                     locked (web session passphrase not yet entered).
 */
export type ConversationEncryptionState =
  | { kind: 'disabled' }
  | { kind: 'checking' }
  | { kind: 'plaintextForced' }
  | {
      kind: 'encrypted'
      protocolId: string
      displayName: string
      fingerprint?: string
      /** The key a trust decision applies to; set with `canVerify` or `canClearVerification`. */
      identityId?: string
      /** Every method's keys for this contact, for the Security tab's list. */
      groups?: PeerIdentityGroup[]
      /** The keys could not be listed this time; the conversation is encrypted all the same. */
      listError?: { retry: () => void }
      trust: TrustState
      isNew?: true
      partlyVerified?: true
      canVerify?: true
      canClearVerification?: true
    }
  | { kind: 'blocked'; pinnedFingerprint: string; advertisedFingerprint: string }
  | { kind: 'unsupported'; groups?: PeerIdentityGroup[]; needsDecision?: true; listError?: { retry: () => void } }
  | { kind: 'rejected'; reasons: EncryptionProblem[]; groups?: PeerIdentityGroup[] }
  | { kind: 'keyLocked'; fingerprint?: string; groups?: PeerIdentityGroup[]; listError?: { retry: () => void } }

/** The identity to show for a conversation: the one in use, or the first of several in use. */
function shownIdentity(identities: PeerIdentity[]): PeerIdentity | undefined {
  return identities.find((i) => i.usedForEncryption)
}

async function resolveState(manager: E2EEManager, peer: string, retry: () => void): Promise<ConversationEncryptionState> {
  const listFailed: ConversationEncryptionState = { kind: 'unsupported', listError: { retry } }
  const security: ConversationSecurity = await manager.getConversationSecurity({ kind: 'direct', peer })
  switch (security.kind) {
    case 'plaintextForced':
      return { kind: 'plaintextForced' }
    case 'unsupported':
      return { kind: 'unsupported' }
    case 'needsDecision': {
      // Nothing can receive messages yet, but the person can still decide on each key.
      const groups = await manager.listPeerIdentities(peer)
      // The manager leaves out a plugin whose listing failed this time; that is a failure to retry.
      if (!groups.some((g) => g.protocolId === security.protocolId)) return listFailed
      return { kind: 'unsupported', needsDecision: true, groups }
    }
    case 'unusable': {
      // The SDK could not read the keys: say so and offer another try, not "no encryption" or "invalid".
      // A protocol was chosen for this contact, so messages and attachments still go out encrypted
      // with it: keep the conversation encrypted rather than let an upload fall back to plaintext.
      if (security.problems.some((p) => p.code === 'listing-failed')) {
        return { kind: 'encrypted', protocolId: security.protocolId, displayName: security.displayName, trust: 'unknown', groups: [], listError: { retry } }
      }
      if (security.problems.length === 0) return { kind: 'unsupported' }
      // The reasons are known already; the rows are a bonus if the listing fails.
      const groups = await manager.listPeerIdentities(peer).catch(() => [])
      return { kind: 'rejected', reasons: security.problems, ...(groups.length > 0 ? { groups } : {}) }
    }
    case 'locked': {
      // The conversation is locked whatever the listing says; a missing group only adds a list error.
      const groups = await manager.listPeerIdentities(peer).catch((): PeerIdentityGroup[] => [])
      const group = groups.find((g) => g.protocolId === security.protocolId)
      return {
        kind: 'keyLocked',
        fingerprint: group && shownIdentity(group.identities)?.fingerprint,
        groups,
        ...(group ? {} : { listError: { retry } }),
      }
    }
    case 'encrypted': {
      // The manager already said messages are encrypted. A listing that fails now must not
      // downgrade that: the state stays encrypted and carries a list error to retry.
      const groups = await manager.listPeerIdentities(peer).catch((): PeerIdentityGroup[] => [])
      const group = groups.find((g) => g.protocolId === security.protocolId)
      const used = group?.identities.filter((i) => i.usedForEncryption) ?? []
      const shown = shownIdentity(group?.identities ?? [])
      // A decision is offered only for a contact with exactly one key in use.
      const only = used.length === 1 ? used[0] : undefined
      return {
        kind: 'encrypted',
        protocolId: security.protocolId,
        displayName: security.displayName,
        trust: security.trust,
        groups,
        ...(group ? {} : { listError: { retry } }),
        ...((security.fingerprint ?? shown?.fingerprint) ? { fingerprint: security.fingerprint ?? shown?.fingerprint } : {}),
        ...(only ? { identityId: only.id } : {}),
        ...(security.isNew ? { isNew: true as const } : {}),
        ...(security.partlyVerified ? { partlyVerified: true as const } : {}),
        ...(only?.allowedDecisions.includes('verified') ? { canVerify: true as const } : {}),
        ...(only?.allowedDecisions.includes('tofu') && only.trust === 'verified' ? { canClearVerification: true as const } : {}),
      }
    }
  }
}

/**
 * Hook powering the composer's encryption chip. Asks the SDK's
 * E2EEManager for the conversation's security whenever the conversation
 * changes, and again whenever the manager reports that a peer's keys, a trust
 * decision or the own key's lock changed. The manager probes and caches, so a
 * repeated question is cheap.
 *
 * `conversationType` is required because MUC rooms must always render
 * as `disabled`: group-chat E2EE isn't wired yet and silently-unencrypted
 * MUC would be misleading.
 */
export function useConversationEncryptionState(
  peerJid: string | null,
  conversationType: 'chat' | 'groupchat',
): ConversationEncryptionState {
  // Subscribe via the narrow useConnectionStatus (status/jid/error) rather than
  // useConnection (~16 fields). This hook is mounted per active conversation and
  // reads only `status`, so the broad subscription re-rendered the encryption chip
  // on unrelated connection churn (ownAvatar, reconnectAttempt, serverInfo, ...).
  const { status } = useConnectionStatus()
  const { client } = useXMPPContext()
  // The master toggle for end-to-end encryption.
  const encryptionEnabled = useEncryptionSettingsStore((s) => s.openpgpEnabled)
  // Changes when a plugin finishes registering, so the question is asked again
  // after async plugin init instead of staying `disabled`.
  const pluginRegisteredAt = useEncryptionSettingsStore((s) => s.pluginRegisteredAt)
  const online = status === 'online'

  // Narrow dep from `client` (which some consumers re-create per render,
  // and every test mock re-creates per render) down to the one stable handle
  // we read. The manager keeps its reference for the session.
  const e2eeManager = client.e2ee ?? null

  const applicable = encryptionEnabled && online && conversationType === 'chat' && !!peerJid && !!e2eeManager

  // The SDK's last answer, tagged with the peer it answers for so a change of
  // conversation shows `checking` rather than the previous contact's state.
  const [answer, setAnswer] = useState<{ peer: string; state: ConversationEncryptionState } | null>(null)
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision((r) => r + 1), [])

  useEffect(() => {
    if (!applicable || !e2eeManager || !peerJid) return
    return e2eeManager.onConversationSecurityChanged((changed) => {
      if (changed === null || changed === peerJid) setRevision((r) => r + 1)
    })
  }, [applicable, e2eeManager, peerJid])

  useEffect(() => {
    if (!applicable || !e2eeManager || !peerJid) return
    let cancelled = false
    void resolveState(e2eeManager, peerJid, retry).then(
      (state) => {
        if (!cancelled) setAnswer({ peer: peerJid, state })
      },
      // A failed question is not a correctness signal: we just cannot encrypt right now.
      () => {
        if (!cancelled) setAnswer({ peer: peerJid, state: { kind: 'unsupported', listError: { retry } } })
      },
    )
    return () => {
      cancelled = true
    }
  }, [applicable, e2eeManager, peerJid, pluginRegisteredAt, revision, retry])

  if (!applicable) return { kind: 'disabled' }
  if (answer === null || answer.peer !== peerJid) return { kind: 'checking' }
  return answer.state
}
