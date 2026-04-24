/**
 * Sequoia-PGP plugin for XEP-0373 (OpenPGP for XMPP, "OX").
 *
 * TypeScript side of the E2EE plugin that bridges to Rust-side crypto
 * operations via Tauri commands (see `apps/fluux/src-tauri/src/openpgp.rs`).
 * Key generation, encryption, decryption, and signature verification all
 * live in Rust; this file handles PEP publication, conversation state,
 * and translation between the Rust output and the SDK's E2EE plugin
 * contract.
 *
 * Key persistence is owned by the Rust side: the secret key is written
 * to an ASCII-armored file under the app data dir, encrypted under a
 * per-account passphrase stored in the OS keychain (with a 0600 file
 * fallback). `openpgp_ensure_key` is idempotent — the first call per
 * account per process generates or loads; subsequent calls are served
 * from an in-memory cache.
 *
 * # PEP publication layout (XEP-0373 §4)
 *
 * Two nodes per identity:
 *
 * - **Metadata** at `urn:xmpp:openpgp:0:public-keys`. Single item
 *   `<public-keys-list xmlns='urn:xmpp:openpgp:0'>` listing every
 *   advertised key's `<pubkey-metadata v4-fingerprint='…' date='…'/>`.
 * - **Data** at `urn:xmpp:openpgp:0:public-keys:FINGERPRINT` (one node
 *   per key). Single item `<pubkey xmlns='urn:xmpp:openpgp:0'><data>
 *   BASE64-armored-public-key</data></pubkey>`.
 *
 * On publish we write data first and metadata second: if metadata ever
 * lists a fingerprint, the data node for that fingerprint is guaranteed
 * to be fetchable. On probe we walk the metadata list, fetch each
 * advertised key, and validate the returned key's fingerprint matches
 * what was advertised.
 *
 * # v6 fingerprints + dual-attribute metadata
 *
 * Fluux emits v6 keys (RFC 9580) whose fingerprints are 64 hex chars.
 * XEP-0373 §4.1.2 names the attribute `v4-fingerprint`, originally
 * designed for 40-char v4 fingerprints. To maximise interop we emit
 * BOTH attributes on every `<pubkey-metadata>` element with the same
 * value (our v6 fingerprint):
 *
 * - `v4-fingerprint` — satisfies parsers that only know the legacy
 *   attribute name. Length-strict implementations (checking for 40
 *   chars) will still reject; loose parsers accept whatever hex they
 *   find there.
 * - `v6-fingerprint` — semantically accurate. Future-forward, and
 *   the attribute we ourselves prefer on read.
 *
 * On parse we look for `v6-fingerprint` first and fall back to
 * `v4-fingerprint`, so a peer emitting either (or both, matching us)
 * is handled. Once the XEP formally adopts v6 we can drop the
 * `v4-fingerprint` emission.
 */

import type {
  BareJID,
  ConversationHandle,
  ConversationTarget,
  DecryptResult,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  IdentityInfo,
  InboundDecryptContext,
  PEPItem,
  PeerSupport,
  PluginContext,
  SecurityContext,
  TrustState,
  VerificationFlow,
  VerificationMethod,
  XMLElementData,
} from '@fluux/sdk'
import {
  E2EEPluginError,
  SigncryptEnvelopeError,
  unwrapSigncrypt,
  wrapForSigncrypt,
  type E2EEErrorKind,
} from '@fluux/sdk'
import { getBareJid } from '@fluux/sdk'
import {
  clearBackedUpFingerprint,
  readBackedUpFingerprint,
  writeBackedUpFingerprint,
} from './backupMarker'

/** XEP-0373 namespace for all PEP/message elements. */
const OX_NAMESPACE = 'urn:xmpp:openpgp:0'
/** XEP-0060 base pubsub namespace. Some PEP servers advertise this on the
 * account JID even when they omit the `pubsub/pep` identity, so we accept
 * either signal as evidence of PEP support. */
const PUBSUB_NAMESPACE = 'http://jabber.org/protocol/pubsub'
/** XEP-0060 §8.7 feature for `<publish-options/>`. We rely on this to pin
 * `accessModel='open'` on public-key nodes and `'whitelist'` on the
 * secret-key backup. A PEP server missing the advertisement may still
 * accept the form (silently or by rejecting it) — we proceed with a
 * warning rather than a hard fail. */
const PUBSUB_PUBLISH_OPTIONS_FEATURE = 'http://jabber.org/protocol/pubsub#publish-options'
/** XEP-0163 §4 PEP service identity advertised on the account's bare JID. */
const PEP_IDENTITY_CATEGORY = 'pubsub'
const PEP_IDENTITY_TYPE = 'pep'
/** PEP node that carries the `<public-keys-list>` metadata document. */
const PUBLIC_KEYS_METADATA_NODE = 'urn:xmpp:openpgp:0:public-keys'
/**
 * PEP node for XEP-0373 §5 secret-key synchronization. Holds one
 * `<secretkey>` item whose `<data>` is a base64-armored OpenPGP message
 * symmetrically encrypted to the user's backup passphrase. MUST be
 * published with `accessModel='whitelist'` so only the owning account
 * can read the ciphertext — even a strong passphrase deserves not to
 * be paired with an offline guessing target that's world-readable.
 */
const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'
/**
 * Build the per-key data node name for `fingerprint`. Each advertised
 * key gets its own node so a rotation can cleanly replace one entry
 * without disturbing the others.
 */
function publicKeyDataNodeFor(fingerprint: string): string {
  return `${PUBLIC_KEYS_METADATA_NODE}:${fingerprint}`
}
/**
 * XEP-0373 uses `id='current'` for the single-item nodes so republishes
 * overwrite cleanly without needing `max_items=1` node config.
 */
const CURRENT_ITEM_ID = 'current'

/**
 * Shape of the Rust-side `PublicKeyInfo` IPC DTO (kept in sync with
 * `openpgp.rs`).
 *
 * Deliberately does NOT include the secret-key armor: encrypt, decrypt,
 * backup, and import all execute in Rust against the cached secret, so
 * the webview never needs the TSK. Keeping it out of JS memory means an
 * XSS / devtools snoop / log leak in the renderer can't exfiltrate the
 * private key.
 *
 * Used both for our own identity (with `keychainBacked` reflecting the
 * actual passphrase backing) and for peer keys parsed from PEP (where
 * `keychainBacked` is always `false` and ignored — see the peer cache
 * write site).
 */
interface KeyBundle {
  fingerprint: string
  publicArmored: string
  /**
   * `true` when the per-account passphrase is stored in the OS keychain;
   * `false` when the Rust side fell through to writing it to a 0600 file
   * under the app data dir. Peer keys always carry `false` — the field
   * is ignored for peer entries.
   */
  keychainBacked: boolean
}

/** Shape of the Rust-side `DecryptOutput` (kept in sync with `openpgp.rs`). */
interface RustDecryptOutput {
  plaintext: string
  signatureVerified: boolean
  /** Present when the Rust side matched a signature against the supplied sender cert. */
  signerFingerprint: string | null
  /**
   * Whether at least one signature packet was observed in the decrypted
   * payload, regardless of whether we could verify it. `false` for
   * cleartext (well, plaintext-encrypted) messages; `true` for any
   * XEP-0373 signcrypt — including ones we couldn't verify yet because
   * the sender's public key hadn't arrived.
   */
  signaturePresent: boolean
}

/**
 * An inbound message whose signature couldn't be checked at decrypt time —
 * typically because the peer's OpenPGP key hadn't finished fetching from
 * PEP yet. Stashed in-memory per-peer so that when the key arrives we can
 * replay the decrypt against it and upgrade the trust badge.
 */
interface PendingVerification {
  messageId: string
  /** Original armored ciphertext, as passed to `openpgp_decrypt`. */
  ciphertext: string
  /** Expected plaintext, cached to skip the re-decrypt round-trip on upgrade. */
  plaintext: string
  /** `Date.now()` at which this entry should be discarded. */
  expiresAt: number
}

/**
 * Maximum pending entries held per-peer. Deliberately small — the race
 * window this buffer exists for is measured in seconds, so ~50 messages
 * covers a very bursty sender. The buffer is strictly an in-memory
 * optimisation and never persisted.
 */
const SIGNATURE_BUFFER_SIZE = 50
/**
 * How long a stashed entry remains eligible for upgrade. Messages older
 * than this stay at `untrusted` forever (the architecture doc calls for
 * a separate manual "re-check signature" path if we ever need to go
 * further back than this).
 */
const SIGNATURE_BUFFER_TTL_MS = 10 * 60 * 1000

/**
 * Maximum allowed delta between the sender's `<time/>` stamp and our local
 * clock before we treat an inbound signcrypt as stale. ±7 days is loose
 * enough that a MAM catch-up of messages a few days old still decrypts,
 * and tight enough that an adversary can't bank a captured ciphertext for
 * years before replaying it.
 */
const SIGNCRYPT_CLOCK_SKEW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Capability-cache TTL (seconds) for a negative `probePeer` result that the
 * plugin classified as permanent — e.g. the peer doesn't publish OpenPGP
 * keys at all. 5 minutes balances "refresh cheaply if they publish later"
 * against "don't pound the server".
 */
const PROBE_NEGATIVE_TTL_SECONDS = 300
/**
 * Capability-cache TTL (seconds) for a negative `probePeer` result whose
 * failure mode is classified as transient (network, IQ timeout, IPC
 * hiccup). Short enough that the next send attempt retries almost
 * immediately — we don't want a 5-minute blackhole after a single flaky
 * round-trip. Long enough that a burst of sends does not fan out a burst
 * of probes.
 */
const PROBE_TRANSIENT_TTL_SECONDS = 30

/**
 * Typed wrapper over Tauri's `invoke`. Abstracted so tests can inject a
 * fake implementation without dynamically importing `@tauri-apps/api/core`.
 */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

/**
 * Classify an error raised across the Tauri/IQ boundary into a
 * transient/permanent verdict plus a short machine-readable code. Used by
 * the plugin to:
 *
 * - pick a short vs full TTL for {@link SequoiaPgpPlugin.probePeer} results
 *   (transient → short TTL so the next send retries; permanent → full TTL
 *   so we don't hammer a peer who genuinely doesn't publish keys),
 * - wrap thrown errors from `ensureIdentity`, `backupSecretKey`, and
 *   `restoreSecretKey` into {@link E2EEPluginError} so the app UI can
 *   distinguish "prompt to unlock again" from "the backup passphrase is
 *   wrong" without string-matching at call sites.
 *
 * The heuristic matches known error-message fragments from the Rust side
 * (`openpgp.rs`, `openpgp_storage.rs`, `openpgp_backup.rs`) and from the
 * IQ-stanza paths the SDK surfaces as `Error` messages. Unknown errors
 * default to `transient` — a retry prompt is the less destructive UX
 * than a spurious "key lost" banner.
 */
function classifyBoundaryError(err: unknown): { kind: E2EEErrorKind; code: string } {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  // Permanent — no retry will help.
  if (msg.includes('no skesk matched')) return { kind: 'permanent', code: 'wrong-passphrase' }
  if (msg.includes('passphrase is empty')) return { kind: 'permanent', code: 'empty-passphrase' }
  if (msg.includes('passphrase for account') && msg.includes('not in the keychain')) {
    return { kind: 'permanent', code: 'key-unrecoverable' }
  }
  if (msg.includes('no key for account') || msg.includes('no identity')) {
    return { kind: 'permanent', code: 'key-missing' }
  }
  if (msg.includes('not a recognizable openpgp')) {
    return { kind: 'permanent', code: 'malformed-key' }
  }
  if (msg.includes('backup input is a public key')) {
    return { kind: 'permanent', code: 'malformed-backup' }
  }
  if (msg.includes('parse ') || msg.includes('not valid')) {
    return { kind: 'permanent', code: 'malformed-data' }
  }
  if (msg.includes('item-not-found')) return { kind: 'permanent', code: 'not-found' }
  if (msg.includes('feature-not-implemented') || msg.includes('does not advertise pep')) {
    return { kind: 'permanent', code: 'pep-unsupported' }
  }

  // Transient — worth retrying.
  if (msg.includes('panicked')) return { kind: 'transient', code: 'ipc-panic' }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return { kind: 'transient', code: 'timeout' }
  }
  if (msg.includes('remote-server-timeout')) return { kind: 'transient', code: 'timeout' }
  if (msg.includes('remote-server-not-found') || msg.includes('service-unavailable')) {
    return { kind: 'transient', code: 'server-unreachable' }
  }
  if (msg.includes('internal-server-error') || msg.includes('resource-constraint')) {
    return { kind: 'transient', code: 'server-error' }
  }

  // Unknown → transient. Prefer a retry prompt over a false "recover" UX.
  return { kind: 'transient', code: 'unknown' }
}

/**
 * Wrap a raw boundary error into an {@link E2EEPluginError} carrying a
 * classified kind + code. Pass-through when `err` is already one of ours,
 * so we don't double-wrap.
 */
function toPluginError(op: string, err: unknown): E2EEPluginError {
  if (err instanceof E2EEPluginError) return err
  const { kind, code } = classifyBoundaryError(err)
  const detail = err instanceof Error ? err.message : String(err)
  return new E2EEPluginError(kind, code, `SequoiaPgpPlugin: ${op}: ${detail}`, err)
}

export interface SequoiaPgpPluginOptions {
  /** Tauri command dispatcher. Tests pass a mock; app code passes the real one. */
  invoke: InvokeFn
}

const descriptor: E2EEProtocolDescriptor = {
  id: 'openpgp',
  displayName: 'OpenPGP (XEP-0373)',
  securityLevel: 30,
  features: {
    forwardSecrecy: false,
    postCompromiseSecurity: false,
    multiDevice: true,
    groupChat: false,
    asynchronous: true,
    deniability: false,
  },
}

export class SequoiaPgpPlugin implements E2EEPlugin {
  readonly descriptor = descriptor

  private readonly invoke: InvokeFn
  private ctx: PluginContext | null = null
  private ownBundle: KeyBundle | null = null
  /** Cached peer public keys, keyed on bare JID. */
  private readonly peerKeys = new Map<BareJID, KeyBundle>()
  /**
   * Per-peer buffer of messages we decrypted before their sender key had
   * arrived. On a subsequent `onPeerKeysChanged` we replay each entry
   * against the new key and, for entries that now verify, report the
   * upgraded security context via the plugin context.
   *
   * Bounded by both {@link SIGNATURE_BUFFER_SIZE} (per-peer) and
   * {@link SIGNATURE_BUFFER_TTL_MS}; entries older than the TTL are
   * pruned lazily at insert time.
   */
  private readonly pendingVerifications = new Map<BareJID, PendingVerification[]>()
  /** Test seam — overridable clock. Production: `Date.now`. */
  private now: () => number = () => Date.now()

  constructor(options: SequoiaPgpPluginOptions) {
    this.invoke = options.invoke
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    if (!ctx.account.jid) {
      throw new Error('SequoiaPgpPlugin requires a logged-in account JID')
    }
    await this.ensureIdentity()
  }

  async shutdown(): Promise<void> {
    // Intentionally does NOT call `openpgp_forget_account`. Shutdown means
    // "this plugin instance is no longer attached to the E2EEManager" —
    // e.g. the user toggled E2EE off in Settings. Preserving the Rust-side
    // key material means a subsequent re-enable reuses the same identity
    // for the rest of the session, rather than silently cycling the user's
    // fingerprint on every toggle. An explicit "delete key" action in the
    // settings UI is the right place to call `openpgp_forget_account`.
    this.ownBundle = null
    this.peerKeys.clear()
    this.pendingVerifications.clear()
    this.ctx = null
  }

  /**
   * Permanently destroy the local key material for this account. Intended
   * to be called from a confirmed, destructive "Delete my OpenPGP key"
   * action — not from shutdown. The next `init` will generate a fresh key
   * with a new fingerprint.
   *
   * Callers who care about peers no longer encrypting to the soon-to-be
   * dead key must call {@link retractPublicKeys} FIRST while the XMPP
   * session and the known fingerprint are both still available. This
   * method deliberately does not trigger retraction itself — retraction
   * can fail for reasons unrelated to local deletion (network, server
   * unavailable) and the caller needs to decide whether to bail or
   * proceed anyway.
   */
  async deleteIdentity(): Promise<void> {
    const accountJid = this.ctx?.account.jid
    if (accountJid) {
      await this.invoke<void>('openpgp_forget_account', { accountJid }).catch(() => {})
      // The local key is gone; any marker pointing at its fingerprint
      // is stale and would mislead the UI on the next key generation.
      clearBackedUpFingerprint(accountJid)
    }
    this.ownBundle = null
    this.peerKeys.clear()
  }

  /**
   * Rotate the encryption subkey. The primary key — and therefore the
   * fingerprint peers verified — is unchanged, so trust survives the
   * rotation transparently: no re-verification ceremony, no churn in
   * the Chat UI's lock badges.
   *
   * What happens end-to-end:
   *
   * 1. Rust generates a fresh `[E]` subkey, expires the superseded one
   *    in place (retained locally so historical MAM stays decryptable),
   *    persists the rotated TSK under the existing at-rest passphrase.
   * 2. We re-publish the public cert to PEP. The data node item carries
   *    only the current `[E]` (Rust strips retired subkeys on the
   *    publish path); the metadata node advertises the same primary
   *    fingerprint with a refreshed `date` attribute.
   * 3. If a backup is published to `urn:xmpp:openpgp:0:secret-key` we
   *    re-wrap with the supplied passphrase so a later restore includes
   *    the new subkey. When `backupPassphrase` is omitted we skip the
   *    backup refresh — the server copy then lags the local cert until
   *    the next explicit {@link backupSecretKey} call.
   *
   * Preconditions: must be called after {@link ensureIdentity}. Throws
   * otherwise — there's no identity material to rotate.
   */
  async rotateEncryptionKey(backupPassphrase?: string): Promise<IdentityInfo> {
    const ctx = this.requireCtx()
    if (!this.ownBundle) {
      throw new E2EEPluginError(
        'permanent',
        'no-identity',
        'SequoiaPgpPlugin: cannot rotate before ensureIdentity has completed',
      )
    }
    const previousFingerprint = this.ownBundle.fingerprint

    let bundle: KeyBundle
    try {
      bundle = await this.invoke<KeyBundle>('openpgp_rotate_encryption_subkey', {
        accountJid: ctx.account.jid,
      })
    } catch (err) {
      throw toPluginError('rotateEncryptionKey', err)
    }

    // Defence in depth: the Rust side guarantees a stable primary FP
    // across rotation, but if that ever regresses we want to surface
    // the break instead of silently publishing a cert peers won't trust.
    if (!fingerprintsEqual(bundle.fingerprint, previousFingerprint)) {
      throw new Error(
        `SequoiaPgpPlugin: rotation produced new fingerprint ${bundle.fingerprint} (expected stable ${previousFingerprint})`,
      )
    }
    this.ownBundle = bundle

    // Re-publish the public cert so senders converge on the current [E].
    // Data node first, metadata second — same ordering as ensureIdentity,
    // for the same reason (never advertise a fingerprint whose data node
    // isn't resolvable).
    try {
      await this.publishOwnPublicKeyData(bundle)
      await this.publishOwnPublicKeyMetadata(bundle)
    } catch (err) {
      ctx.logger.warn(
        `SequoiaPgpPlugin: rotated key publish failed: ${formatError(err)}`,
      )
    }

    // Re-wrap the server-side backup only when the caller supplied the
    // passphrase — rotation without a passphrase at hand is still a
    // valid operation (the local cert is already persisted), just
    // leaves the server backup stale until the next manual backup.
    if (backupPassphrase !== undefined) {
      try {
        await this.backupSecretKey(backupPassphrase)
      } catch (err) {
        ctx.logger.warn(
          `SequoiaPgpPlugin: rotated backup publish failed: ${formatError(err)}`,
        )
      }
    }

    return { fingerprint: bundle.fingerprint }
  }

  /**
   * Retract our published public key from PEP so peers stop encrypting to
   * this identity. Retracts the per-fingerprint data node item first, then
   * the metadata list — order mirrors the inverse of publish so peers
   * never see "metadata points to a fingerprint whose data node is gone".
   *
   * Servers normally tolerate retracting an already-absent item silently;
   * we still `.catch(() => {})` each call so a partially-published state
   * (metadata present, data missing, or vice versa) doesn't break the
   * caller's flow. Returns without error when there's nothing to retract.
   */
  async retractPublicKeys(): Promise<void> {
    const ctx = this.requireCtx()
    const fingerprint = this.ownBundle?.fingerprint
    // Retract metadata first so peers immediately stop discovering the
    // fingerprint, then clean up the data node. The opposite order would
    // briefly leave metadata pointing at a 404 data node.
    await ctx.xmpp
      .retractPEP(PUBLIC_KEYS_METADATA_NODE, CURRENT_ITEM_ID)
      .catch((err) => {
        ctx.logger.debug(
          `SequoiaPgpPlugin: retract metadata failed: ${formatError(err)}`,
        )
      })
    if (fingerprint) {
      await ctx.xmpp
        .retractPEP(publicKeyDataNodeFor(fingerprint), CURRENT_ITEM_ID)
        .catch((err) => {
          ctx.logger.debug(
            `SequoiaPgpPlugin: retract data node for ${fingerprint} failed: ${formatError(err)}`,
          )
        })
    }
  }

  /**
   * Retract the server-side secret-key backup. Idempotent — safe to call
   * when no backup is published. Intended for the "also delete my backup"
   * branch of the destructive delete flow; the default delete path
   * preserves the backup so the user can still restore.
   */
  async retractSecretKeyBackup(): Promise<void> {
    const ctx = this.requireCtx()
    await ctx.xmpp.retractPEP(SECRET_KEY_NODE, CURRENT_ITEM_ID).catch((err) => {
      ctx.logger.debug(
        `SequoiaPgpPlugin: retract secret-key backup failed: ${formatError(err)}`,
      )
    })
    // The server backup is (best-effort) gone — a stale marker would
    // tell the UI "in sync" next time and hide the backup button.
    clearBackedUpFingerprint(ctx.account.jid)
  }

  // ---- XEP-0373 §5 Secret Key Synchronization ------------------------

  /**
   * Encrypt the in-memory TSK under `passphrase` and publish it to the
   * secret-key PEP node. `accessModel: 'whitelist'` locks the node to
   * the owning account — third parties can't even fetch the ciphertext.
   *
   * Callers must have successfully called {@link ensureIdentity} first;
   * otherwise there's nothing to back up. The encrypt step runs
   * server-side of the IPC boundary (Argon2 KDF) so it's async and
   * may take a moment on slower machines.
   */
  async backupSecretKey(passphrase: string): Promise<void> {
    const ctx = this.requireCtx()
    if (!this.ownBundle) {
      throw new E2EEPluginError(
        'permanent',
        'no-identity',
        'SequoiaPgpPlugin: no identity to back up — call ensureIdentity first',
      )
    }
    let armoredMessage: string
    try {
      armoredMessage = await this.invoke<string>('openpgp_backup_encrypt', {
        accountJid: ctx.account.jid,
        passphrase,
      })
    } catch (err) {
      throw toPluginError('backupSecretKey', err)
    }
    const payload: XMLElementData = {
      name: 'secretkey',
      attrs: { xmlns: OX_NAMESPACE },
      children: [
        {
          name: 'data',
          attrs: {},
          children: [base64Encode(armoredMessage)],
        },
      ],
    }
    await ctx.xmpp.publishPEP(
      SECRET_KEY_NODE,
      { id: CURRENT_ITEM_ID, payload },
      { accessModel: 'whitelist', maxItems: 1, persistItems: true },
    )
    // Record which fingerprint we just pushed. The UI compares this
    // against the current local fingerprint to tell "already in sync"
    // from "backup needed" without re-prompting for the passphrase.
    writeBackedUpFingerprint(ctx.account.jid, this.ownBundle.fingerprint)
  }

  /**
   * Retrieve the current secret-key backup from our own PEP, or `null`
   * if no backup is published. Returns the armored OpenPGP message
   * (what Rust's `openpgp_backup_import` expects) — the caller is
   * responsible for prompting the user for a passphrase and handing
   * both to {@link restoreSecretKey}.
   */
  async fetchSecretKeyBackup(): Promise<string | null> {
    const ctx = this.requireCtx()
    try {
      const items = await ctx.xmpp.queryPEP(ctx.account.jid, SECRET_KEY_NODE)
      for (const item of items) {
        const armored = parseSecretKeyBackupItem(item.payload)
        if (armored) return armored
      }
    } catch (err) {
      // A server that hasn't seen the node before returns
      // `item-not-found` — that's a perfectly normal "no backup yet"
      // outcome, not an error the caller should propagate.
      ctx.logger.debug(
        `SequoiaPgpPlugin: fetchSecretKeyBackup: ${formatError(err)} (treated as no backup)`,
      )
    }
    return null
  }

  /**
   * Convenience check: does our PEP currently hold a backup? Implemented
   * on top of {@link fetchSecretKeyBackup} rather than a disco round-trip
   * because the fetch is the same cost and gives the caller the
   * ciphertext if it decides to restore immediately after.
   */
  async hasSecretKeyBackup(): Promise<boolean> {
    return (await this.fetchSecretKeyBackup()) !== null
  }

  /**
   * Fetch the backup, decrypt with `passphrase`, persist locally, and
   * re-publish the public key so peers converge on the restored
   * identity. Any previously-cached local bundle for this account is
   * replaced — callers should reserve this method for a confirmed
   * "restore from server" user action.
   *
   * Throws when no backup exists or when the passphrase is wrong; the
   * UI layer distinguishes by inspecting the error message or by
   * calling {@link fetchSecretKeyBackup} first.
   */
  async restoreSecretKey(passphrase: string): Promise<IdentityInfo> {
    const ctx = this.requireCtx()
    const armoredMessage = await this.fetchSecretKeyBackup()
    if (!armoredMessage) {
      throw new E2EEPluginError(
        'permanent',
        'no-backup',
        'SequoiaPgpPlugin: no secret-key backup found on server',
      )
    }
    let bundle: KeyBundle
    try {
      bundle = await this.invoke<KeyBundle>('openpgp_backup_import', {
        accountJid: ctx.account.jid,
        backupMessage: armoredMessage,
        passphrase,
      })
    } catch (err) {
      // Wrong passphrase is the common case here — classifyBoundaryError
      // maps Rust's "no SKESK matched the supplied passphrase" to
      // `permanent/wrong-passphrase`, which the UI uses to show the
      // "try another passphrase" prompt instead of a retry button.
      throw toPluginError('restoreSecretKey', err)
    }
    this.ownBundle = bundle
    // Restore means local key == server backup by construction. Mark
    // the sync state so the UI hides the backup/restore buttons.
    writeBackedUpFingerprint(ctx.account.jid, bundle.fingerprint)

    // Re-advertise our public key so peers can encrypt to the restored
    // identity. A failure here isn't fatal for the restore itself — the
    // key is already usable locally — but peers will be blind to us
    // until a later publish succeeds.
    try {
      await this.publishOwnPublicKeyData(bundle)
      await this.publishOwnPublicKeyMetadata(bundle)
    } catch (err) {
      ctx.logger.warn(
        `SequoiaPgpPlugin: public key publish after restore failed: ${formatError(err)}`,
      )
    }

    return { fingerprint: bundle.fingerprint }
  }

  /**
   * Generate or load our key via Rust, then publish it to PEP in
   * XEP-0373 §4.1 layout (data node first, metadata node second).
   *
   * Idempotent on both sides: Rust returns the cached bundle within a
   * session and reads the persisted file across restarts, so the
   * fingerprint is stable for the lifetime of the account.
   *
   * A failure to publish leaves local state untouched — encryption of
   * incoming messages still works (peers can still send to us if they
   * have our key), we just won't be discoverable until a later
   * successful publish.
   */
  async ensureIdentity(): Promise<IdentityInfo> {
    const ctx = this.requireCtx()
    let bundle: KeyBundle
    try {
      bundle = await this.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: ctx.account.jid,
        userId: ctx.account.jid,
      })
    } catch (err) {
      // Surface a classified error so the app layer can pick the right
      // UX — transient (keychain momentarily locked, IPC timeout) lets
      // the user retry, permanent (key-unrecoverable, malformed data)
      // points at the recovery flow.
      throw toPluginError('ensureIdentity', err)
    }
    this.ownBundle = bundle
    if (!bundle.keychainBacked) {
      ctx.logger.warn(
        'SequoiaPgpPlugin: passphrase stored on disk (0600 fallback) — keychain was unavailable',
      )
    }

    // Verify the server speaks XEP-0163 PEP before attempting to
    // publish. Without this probe a non-PEP server (or a deployment
    // that disabled PEP) would silently swallow our publishes — peers
    // would never see our key, and the user would think OpenPGP was
    // working. The probe runs AFTER key generation so a transient
    // server-side issue doesn't block local key material from being
    // ready for a later retry.
    await this.probePepSupport()

    try {
      // Publish the data node FIRST. If the data publish fails we
      // deliberately skip the metadata step: advertising a fingerprint
      // whose data node returns 404 would break peers' probe path.
      await this.publishOwnPublicKeyData(bundle)
      await this.publishOwnPublicKeyMetadata(bundle)
    } catch (err) {
      ctx.logger.warn(
        `SequoiaPgpPlugin: public key publish failed: ${formatError(err)}`,
      )
    }

    return { fingerprint: bundle.fingerprint }
  }

  /**
   * Disco#info on the account's bare JID to confirm PEP (XEP-0163) is
   * available before any publish. PEP services advertise either the
   * `{category:'pubsub', type:'pep'}` identity or the base
   * `http://jabber.org/protocol/pubsub` feature; we accept either.
   *
   * Hard-throws when the server clearly doesn't support PEP — the
   * surrounding registration path catches this and logs it, so the
   * plugin fails to register and the chat continues in cleartext rather
   * than silently pretending OpenPGP is on.
   *
   * Soft-warns when PEP is present but the `publish-options` feature is
   * not advertised. Some servers that DO support `<publish-options/>`
   * forget to list it in disco; the publish itself will tell us if the
   * accessModel pinning was honored, so we proceed rather than block.
   *
   * Only called from {@link ensureIdentity}: rotation and restore both
   * presuppose a successful prior `ensureIdentity`, so they inherit the
   * confirmation rather than re-paying the round-trip.
   */
  private async probePepSupport(): Promise<void> {
    const ctx = this.requireCtx()
    let disco
    try {
      disco = await ctx.xmpp.queryDisco(ctx.account.jid)
    } catch (err) {
      // Disco round-trip failures are almost always network/server
      // hiccups rather than "the server definitively lacks PEP" — keep
      // the transient classification so the app can retry rather than
      // throw up a hard "OpenPGP unsupported" banner.
      throw toPluginError('pep-support-probe', err)
    }
    const hasPepIdentity = disco.identities.some(
      (id) => id.category === PEP_IDENTITY_CATEGORY && id.type === PEP_IDENTITY_TYPE,
    )
    const hasPubsubFeature = disco.features.some((f) => f.var === PUBSUB_NAMESPACE)
    if (!hasPepIdentity && !hasPubsubFeature) {
      throw new E2EEPluginError(
        'permanent',
        'pep-unsupported',
        `SequoiaPgpPlugin: account JID ${ctx.account.jid} does not advertise PEP (XEP-0163); OpenPGP key publication is unsupported on this server`,
      )
    }
    if (!disco.features.some((f) => f.var === PUBSUB_PUBLISH_OPTIONS_FEATURE)) {
      ctx.logger.warn(
        'SequoiaPgpPlugin: PEP present but `publish-options` feature not advertised — proceeding; accessModel pinning may be ignored',
      )
    }
  }

  /**
   * Publish `<pubkey><data>BASE64</data></pubkey>` at
   * `urn:xmpp:openpgp:0:public-keys:FP`.
   *
   * The publish-options pin the node to `accessModel='open'` so that
   * non-roster peers can fetch the key and start an encrypted DM —
   * which is XEP-0373's whole point. Without an explicit access model
   * most servers default to `presence`, restricting fetches to roster
   * contacts. `maxItems=1` and `persistItems=true` make this a stable
   * current-value node: rotating the key just overwrites the slot.
   */
  private async publishOwnPublicKeyData(bundle: KeyBundle): Promise<void> {
    const ctx = this.requireCtx()
    const payload: XMLElementData = {
      name: 'pubkey',
      attrs: { xmlns: OX_NAMESPACE },
      children: [
        {
          name: 'data',
          attrs: {},
          children: [base64Encode(bundle.publicArmored)],
        },
      ],
    }
    await ctx.xmpp.publishPEP(
      publicKeyDataNodeFor(bundle.fingerprint),
      { id: CURRENT_ITEM_ID, payload },
      { accessModel: 'open', persistItems: true, maxItems: 1 },
    )
  }

  /**
   * Publish `<public-keys-list><pubkey-metadata .../></public-keys-list>`
   * at `urn:xmpp:openpgp:0:public-keys`. The `date` attribute is the
   * publish time, not the key's creation time — that's what XEP-0373
   * §4.1.2 specifies.
   *
   * Emits BOTH `v4-fingerprint` (legacy XEP attribute name) AND
   * `v6-fingerprint` (semantically accurate for our RFC 9580 keys)
   * with the same value. See the module-level docstring for the
   * interop rationale.
   */
  private async publishOwnPublicKeyMetadata(bundle: KeyBundle): Promise<void> {
    const ctx = this.requireCtx()
    const payload: XMLElementData = {
      name: 'public-keys-list',
      attrs: { xmlns: OX_NAMESPACE },
      children: [
        {
          name: 'pubkey-metadata',
          attrs: {
            'v4-fingerprint': bundle.fingerprint,
            'v6-fingerprint': bundle.fingerprint,
            date: new Date().toISOString(),
          },
          children: [],
        },
      ],
    }
    await ctx.xmpp.publishPEP(
      PUBLIC_KEYS_METADATA_NODE,
      { id: CURRENT_ITEM_ID, payload },
      { accessModel: 'open', persistItems: true, maxItems: 1 },
    )
  }

  /**
   * XEP-0373 §4.2 two-step fetch: read the peer's metadata node to
   * discover which fingerprints they advertise, then fetch each
   * advertised key's data node. We cache the first key that validates
   * (matches its advertised fingerprint); additional keys are ignored
   * for this phase. Multi-key support — e.g. picking the most recent,
   * or verifying against a per-peer allowlist — is a later slice.
   *
   * Negative results are returned with two distinct TTLs:
   * - permanent (peer has no PEP entry, `item-not-found`, malformed
   *   advertisement) → {@link PROBE_NEGATIVE_TTL_SECONDS}. The peer
   *   genuinely doesn't publish; the host cache holds the verdict so
   *   subsequent sends don't re-probe.
   * - transient (network/timeout/server-unreachable) →
   *   {@link PROBE_TRANSIENT_TTL_SECONDS}. A 5-minute blackhole from a
   *   single flaky round-trip would be user-hostile; the short TTL lets
   *   the next send retry.
   */
  async probePeer(peer: BareJID): Promise<PeerSupport> {
    const ctx = this.requireCtx()
    if (this.peerKeys.has(peer)) {
      return { supported: true, ttl: PROBE_NEGATIVE_TTL_SECONDS }
    }
    try {
      const metadataItems = await ctx.xmpp.queryPEP(peer, PUBLIC_KEYS_METADATA_NODE)
      const fingerprints = parseAdvertisedFingerprints(metadataItems)
      if (fingerprints.length === 0) {
        // Peer advertises no fingerprints — this is a clear "doesn't
        // support", not a failure we should re-probe soon.
        return { supported: false, ttl: PROBE_NEGATIVE_TTL_SECONDS }
      }

      for (const fingerprint of fingerprints) {
        const bundle = await this.fetchAdvertisedKey(peer, fingerprint)
        if (bundle) {
          this.peerKeys.set(peer, bundle)
          return { supported: true, ttl: PROBE_NEGATIVE_TTL_SECONDS }
        }
      }
      // Metadata advertised keys but none resolved / validated. Treat as
      // permanent-ish: the advertisement itself is stable, cache long.
      return { supported: false, ttl: PROBE_NEGATIVE_TTL_SECONDS }
    } catch (err) {
      const { kind, code } = classifyBoundaryError(err)
      ctx.logger.debug(
        `SequoiaPgpPlugin: probePeer(${peer}) failed (${kind}/${code}): ${formatError(err)}`,
      )
      return {
        supported: false,
        ttl: kind === 'transient' ? PROBE_TRANSIENT_TTL_SECONDS : PROBE_NEGATIVE_TTL_SECONDS,
      }
    }
  }

  /**
   * Pull one advertised key's data node. Returns `null` when the node
   * has no parseable key item, or when the fetched key's fingerprint
   * doesn't match what the metadata node advertised — that mismatch is
   * a loud defensive check against a misconfigured or tampered PEP
   * node (e.g. a server rewriting items under its tenants' JIDs).
   *
   * Fingerprint extraction is delegated to the Rust side
   * (`openpgp_fingerprint`, backed by Sequoia) so we handle every armor
   * flavor the spec allows — RFC 9580 v6 keys emit a `Comment:` header
   * rather than the legacy `Fingerprint:` header, and a JS regex parser
   * silently mis-identified those as invalid.
   */
  private async fetchAdvertisedKey(
    peer: BareJID,
    fingerprint: string,
  ): Promise<KeyBundle | null> {
    const ctx = this.requireCtx()
    try {
      const items = await ctx.xmpp.queryPEP(peer, publicKeyDataNodeFor(fingerprint))
      for (const item of items) {
        const armored = parsePublicKeyDataItem(item.payload)
        if (!armored) continue
        let parsedFingerprint: string
        try {
          parsedFingerprint = await this.invoke<string>('openpgp_fingerprint', {
            publicArmored: armored,
          })
        } catch (err) {
          ctx.logger.debug(
            `SequoiaPgpPlugin: openpgp_fingerprint for ${peer}/${fingerprint} failed: ${formatError(err)}`,
          )
          continue
        }
        if (!fingerprintsEqual(parsedFingerprint, fingerprint)) {
          ctx.logger.warn(
            `SequoiaPgpPlugin: ${peer} advertised ${fingerprint} but served key with ${parsedFingerprint}; discarding`,
          )
          continue
        }
        return {
          fingerprint: parsedFingerprint,
          publicArmored: armored,
          // Flag only meaningful on our own identity — peers always `false`.
          keychainBacked: false,
        }
      }
    } catch (err) {
      ctx.logger.debug(
        `SequoiaPgpPlugin: fetch ${peer} key ${fingerprint} failed: ${formatError(err)}`,
      )
    }
    return null
  }

  async openConversation(target: ConversationTarget): Promise<ConversationHandle> {
    if (target.kind !== 'direct') {
      throw new Error('SequoiaPgpPlugin: MUC encryption is not supported in this phase')
    }
    return { protocolId: descriptor.id, state: { peer: target.peer } }
  }

  async closeConversation(_handle: ConversationHandle): Promise<void> {
    // Stateless — no per-conversation resources to release.
  }

  async encrypt(handle: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload> {
    const ctx = this.requireCtx()
    const peer = extractPeer(handle)
    const peerBundle = this.peerKeys.get(peer)
    if (!peerBundle) {
      throw new Error(`SequoiaPgpPlugin: no cached public key for ${peer} — probe first`)
    }

    // Chat.ts hands us a serialized `<payload xmlns='jabber:client'>…</payload>`
    // (see payloadEnvelope.serialize). Wrap it per XEP-0373 §4.1 so the
    // ciphertext carries reflection/replay/length-hiding affixes on top of
    // the OpenPGP signature. The wrapped string is what Rust signs+encrypts.
    const payloadXml = new TextDecoder().decode(plaintext)
    const envelope = wrapForSigncrypt({
      payloadXml,
      peerJid: getBareJid(peer),
      timestamp: new Date(this.now()),
    })
    const ciphertext = await this.invoke<string>('openpgp_encrypt', {
      senderAccountJid: ctx.account.jid,
      recipientPublicArmored: peerBundle.publicArmored,
      plaintext: envelope,
    })

    const stanzaElement: XMLElementData = {
      name: 'openpgp',
      attrs: { xmlns: OX_NAMESPACE },
      children: [base64Encode(ciphertext)],
    }
    return {
      protocolId: descriptor.id,
      stanzaElement,
      fallbackBody: '[OpenPGP-encrypted message]',
    }
  }

  async decrypt(
    handle: ConversationHandle,
    payload: EncryptedPayload,
    context?: InboundDecryptContext,
  ): Promise<DecryptResult> {
    const ctx = this.requireCtx()
    if (payload.protocolId !== descriptor.id) {
      throw new Error(`SequoiaPgpPlugin cannot decrypt protocol: ${payload.protocolId}`)
    }
    const encodedCiphertext = firstText(payload.stanzaElement)
    if (!encodedCiphertext) {
      throw new Error('SequoiaPgpPlugin: encrypted element has no payload')
    }
    const ciphertext = base64Decode(encodedCiphertext)

    const peer = extractPeer(handle)
    const senderPublicArmored = this.peerKeys.get(peer)?.publicArmored ?? null

    const rust = await this.invoke<RustDecryptOutput>('openpgp_decrypt', {
      accountJid: ctx.account.jid,
      ciphertext,
      senderPublicArmored,
    })

    // The decrypted plaintext MUST be a XEP-0373 §4.1 `<signcrypt/>`
    // envelope. Unwrap it, enforce the reflection + replay policies the
    // envelope enables, and surface the inner `<payload/>` as the plaintext
    // stanzaDecrypt expects. Anything that fails shape validation, the
    // reflection check, or the skew window is thrown as a classified
    // E2EEPluginError — we never silently fall back to raw plaintext.
    const envelope = this.unwrapOrRethrow(rust.plaintext)
    const ownBareJid = getBareJid(ctx.account.jid)
    if (!envelope.addressees.some((addr: string) => getBareJid(addr) === ownBareJid)) {
      throw new E2EEPluginError(
        'permanent',
        'envelope-reflection',
        `SequoiaPgpPlugin: signcrypt <to/> does not address ${ownBareJid} (peer ${peer}, addressees [${envelope.addressees.join(', ')}])`,
      )
    }
    const skew = Math.abs(envelope.timestamp.getTime() - this.now())
    if (skew > SIGNCRYPT_CLOCK_SKEW_MS) {
      throw new E2EEPluginError(
        'permanent',
        'envelope-stale',
        `SequoiaPgpPlugin: signcrypt <time/> is ${Math.round(skew / 1000)}s outside the ±7-day skew window (stamp: ${envelope.timestamp.toISOString()})`,
      )
    }

    const plaintext = new TextEncoder().encode(envelope.payloadXml)
    const securityContext = this.buildInboundSecurityContext(peer, rust)

    // Stash only for the specific race this buffer exists for: we had no
    // sender cert at decrypt time AND the message actually carried a
    // signature. A verified result needs no stash (nothing to upgrade); a
    // signed message that failed verification against a cached cert stays
    // untrusted forever (a rotation won't rehabilitate a bad sig); an
    // unsigned message has nothing to re-check.
    if (
      context?.messageId &&
      !rust.signatureVerified &&
      rust.signaturePresent &&
      !senderPublicArmored
    ) {
      this.stashPendingVerification(peer, {
        messageId: context.messageId,
        ciphertext,
        plaintext: rust.plaintext,
        expiresAt: this.now() + SIGNATURE_BUFFER_TTL_MS,
      })
    }

    return {
      plaintext,
      senderDevice: {
        jid: peer,
        deviceId: rust.signerFingerprint ?? this.peerKeys.get(peer)?.fingerprint ?? 'unknown',
      },
      securityContext,
      // Envelope `<time/>` is sender-attested and signed inside the
      // ciphertext — more trustworthy than `<delay/>` (which a relay can
      // rewrite) or local arrival time. Downstream (Chat, MAM) uses it as
      // the message's display timestamp.
      authoredAt: envelope.timestamp,
    }
  }

  /**
   * Insert (or update) a pending-verification entry for `peer`. Prunes any
   * expired entries first, then enforces the per-peer size cap by evicting
   * the oldest entries. An entry for the same `messageId` replaces the
   * previous one so duplicate deliveries don't stack up.
   */
  private stashPendingVerification(peer: BareJID, entry: PendingVerification): void {
    const existing = this.pendingVerifications.get(peer) ?? []
    // Lazy prune: drop expired entries before deciding whether to evict.
    const now = this.now()
    const alive = existing.filter((e) => e.expiresAt > now && e.messageId !== entry.messageId)
    alive.push(entry)
    // Oldest-first eviction once we're over the cap. `alive` was built by
    // appending newer entries, so the head is the oldest — drop from there.
    while (alive.length > SIGNATURE_BUFFER_SIZE) {
      alive.shift()
    }
    this.pendingVerifications.set(peer, alive)
  }

  /**
   * Replay every stashed entry for `peer` against the currently-cached
   * sender key. For entries that now verify, patch the security context
   * and report an upgrade through the plugin context; drop verified or
   * expired entries from the buffer either way.
   *
   * Runs serially to keep the Rust-side IPC load predictable — a buffer of
   * 50 entries is small enough that sequential invokes finish quickly and
   * parallelism would only invite races on the shared cached-peer state.
   */
  private async drainPendingVerifications(peer: BareJID): Promise<void> {
    const ctx = this.ctx
    const entries = this.pendingVerifications.get(peer)
    if (!ctx || !entries || entries.length === 0) return

    const peerBundle = this.peerKeys.get(peer)
    if (!peerBundle) {
      // We evicted the peer cache on PEP change; no key yet → probe will
      // happen on the next send. Lazy-prune expired entries while we wait.
      const now = this.now()
      const alive = entries.filter((e) => e.expiresAt > now)
      if (alive.length === 0) this.pendingVerifications.delete(peer)
      else this.pendingVerifications.set(peer, alive)
      return
    }

    const now = this.now()
    const remaining: PendingVerification[] = []
    for (const entry of entries) {
      if (entry.expiresAt <= now) continue // TTL expired — drop quietly.
      try {
        const rust = await this.invoke<RustDecryptOutput>('openpgp_decrypt', {
          accountJid: ctx.account.jid,
          ciphertext: entry.ciphertext,
          senderPublicArmored: peerBundle.publicArmored,
        })
        // Guard against the Rust side returning a different plaintext than
        // we stashed. The identical ciphertext must decrypt to the same
        // plaintext — a mismatch means something went wrong, keep the
        // entry out of the buffer and don't report a spurious upgrade.
        if (rust.plaintext !== entry.plaintext) continue
        if (rust.signatureVerified) {
          const securityContext = this.buildInboundSecurityContext(peer, rust)
          ctx.reportSecurityContextUpdate({
            peer,
            messageId: entry.messageId,
            securityContext,
          })
          // Evict — upgrade delivered, no need to replay again.
          continue
        }
        // Signature still doesn't verify against the new key — keep the
        // entry so a *subsequent* rotation still has a shot. (When it
        // eventually expires it'll be dropped by the TTL filter.)
        remaining.push(entry)
      } catch (err) {
        ctx.logger.debug(
          `SequoiaPgpPlugin: re-verify for ${peer}/${entry.messageId} failed: ${formatError(err)}`,
        )
        remaining.push(entry)
      }
    }
    if (remaining.length === 0) this.pendingVerifications.delete(peer)
    else this.pendingVerifications.set(peer, remaining)
  }

  /**
   * Test seam — override the clock used for TTL calculations. Production
   * code uses the default `Date.now`; tests inject a monotonic counter so
   * TTL-based eviction can be exercised without timers.
   * @internal
   */
  _setClockForTesting(fn: () => number): void {
    this.now = fn
  }

  /**
   * Turn the Rust-side signature verification result into the trust state
   * the Chat UI renders. Three outcomes:
   *
   * - `trusted`   — signature verified against the peer's cached cert. This
   *                 is the BTBV "seen-this-peer-before + message actually
   *                 signed by them" state. Upgraded to `verified` only via
   *                 an explicit user verification action (future slice).
   * - `untrusted` — no cached peer cert (verification couldn't be
   *                 attempted), signature missing, or signature didn't
   *                 match the peer's cert. The user sees a yellow lock.
   *
   * The sanity check that `signerFingerprint` matches the cached peer's
   * own fingerprint guards against a future bug where Rust returns a
   * valid signature from the wrong cert; defence in depth.
   */
  private buildInboundSecurityContext(
    peer: BareJID,
    rust: RustDecryptOutput,
  ): SecurityContext {
    const cached = this.peerKeys.get(peer)
    const fingerprintMatches =
      cached && rust.signerFingerprint && cached.fingerprint === rust.signerFingerprint
    const trust: SecurityContext['trust'] =
      rust.signatureVerified && fingerprintMatches ? 'trusted' : 'untrusted'

    const notes: string[] = []
    if (!rust.signatureVerified) {
      notes.push(cached ? 'Signature did not verify' : 'Sender key not cached — signature not checked')
    } else if (!fingerprintMatches) {
      notes.push('Signature verified but fingerprint does not match cached peer')
    }

    return {
      protocolId: descriptor.id,
      trust,
      ...(notes.length > 0 && { notes }),
    }
  }

  getVerificationMethods(): VerificationMethod[] {
    return [
      {
        id: 'fingerprint',
        displayName: 'Fingerprint comparison',
        description: "Compare the hex fingerprint with your contact's other client.",
      },
    ]
  }

  async startVerification(_peer: BareJID, _method: VerificationMethod): Promise<VerificationFlow> {
    // UX slice — deferred. The flow will hang a modal off a
    // VerificationUIAdapter provided by the host (see architecture doc).
    throw new Error('SequoiaPgpPlugin: verification UI not wired yet')
  }

  async getPeerTrust(peer: BareJID): Promise<TrustState> {
    return this.evaluatePeerTrust(peer)
  }

  async getDeviceTrust(peer: BareJID, _deviceId: string): Promise<TrustState> {
    return this.evaluatePeerTrust(peer)
  }

  tryClaimInbound(stanzaChild: XMLElementData): EncryptedPayload | null {
    if (stanzaChild.name !== 'openpgp') return null
    if (stanzaChild.attrs?.xmlns !== OX_NAMESPACE) return null
    return {
      protocolId: descriptor.id,
      stanzaElement: stanzaChild,
    }
  }

  /**
   * Evict the cached public key for `peer` and kick off re-verification of
   * any messages we previously stashed because their signatures couldn't
   * be checked. Called by the host on a PEP headline — either a key
   * rotation or the first-ever publish (the case we most care about: a
   * brand-new peer whose messages landed seconds before their PEP fetch
   * completed).
   *
   * Re-verification is async: we fetch the now-current key via
   * {@link probePeer} and replay each stashed ciphertext against it.
   * Errors are swallowed — a failed probe or a transient IPC hiccup
   * leaves the stash in place; the TTL will eventually clean it up.
   */
  onPeerKeysChanged(peer: BareJID): void {
    this.peerKeys.delete(peer)
    if (!this.pendingVerifications.get(peer)?.length) return
    // Fire-and-forget: the host's notifyPeerKeysChanged is sync, and we
    // don't want to block the PEP dispatch path on IPC. The caller
    // doesn't need the return value; errors are logged inside the drain.
    void (async () => {
      try {
        await this.probePeer(peer)
      } catch (err) {
        this.ctx?.logger.debug(
          `SequoiaPgpPlugin: probePeer after key rotation failed for ${peer}: ${formatError(err)}`,
        )
      }
      await this.drainPendingVerifications(peer)
    })()
  }

  /** Own fingerprint, or `null` if ensureIdentity hasn't completed. */
  getOwnFingerprint(): string | null {
    return this.ownBundle?.fingerprint ?? null
  }

  /**
   * Fingerprint last pushed to (or pulled from) the server-side backup
   * node, or `null` when no backup has been recorded on this device.
   * The UI compares this to {@link getOwnFingerprint} to decide whether
   * the backup/restore buttons are needed.
   */
  getBackedUpFingerprint(): string | null {
    const jid = this.ctx?.account.jid
    if (!jid) return null
    return readBackedUpFingerprint(jid)
  }

  /** Cached peer fingerprint, or `null` if not probed / not published. */
  getPeerFingerprint(peer: BareJID): string | null {
    return this.peerKeys.get(peer)?.fingerprint ?? null
  }

  /**
   * TOFU for the skeleton: a peer we've seen a key from is "trusted",
   * unseen peers are "unknown". The follow-up verification UX will lift
   * confirmed peers to "verified"; a key rotation without re-verification
   * drops back to "trusted".
   */
  private async evaluatePeerTrust(peer: BareJID): Promise<TrustState> {
    return this.peerKeys.has(peer) ? 'trusted' : 'unknown'
  }

  private requireCtx(): PluginContext {
    if (!this.ctx) throw new Error('SequoiaPgpPlugin: not initialized')
    return this.ctx
  }

  /**
   * Parse the XEP-0373 §4.1 signcrypt envelope Rust returned to us and
   * translate any shape-validation failure into a classified
   * {@link E2EEPluginError}. Isolated here so the decrypt flow stays
   * linear — try/catch for the inside-Rust boundary already lives one
   * level up, this wraps the envelope-layer failure mode.
   */
  private unwrapOrRethrow(plaintext: string) {
    try {
      return unwrapSigncrypt(plaintext)
    } catch (err) {
      if (err instanceof SigncryptEnvelopeError) {
        throw new E2EEPluginError(
          'permanent',
          `envelope-${err.code}`,
          `SequoiaPgpPlugin: signcrypt envelope rejected: ${err.message}`,
          err,
        )
      }
      throw err
    }
  }
}

function extractPeer(handle: ConversationHandle): BareJID {
  const state = handle.state as { peer?: BareJID } | undefined
  const peer = state?.peer
  if (!peer) throw new Error('SequoiaPgpPlugin: conversation handle is missing peer JID')
  return peer
}

/**
 * Extract every advertised fingerprint from a peer's metadata node
 * items (XEP-0373 §4.1.2). Accepts a list because the PEP server may
 * return multiple history items; we walk them all and take every
 * `<pubkey-metadata v4-fingerprint='…' />` we find. Order is preserved
 * so callers can prefer newer entries when the server returns history.
 */
function parseAdvertisedFingerprints(items: PEPItem[]): string[] {
  const fingerprints: string[] = []
  for (const item of items) {
    const list = item.payload
    if (list.name !== 'public-keys-list' || list.attrs?.xmlns !== OX_NAMESPACE) continue
    for (const child of list.children) {
      if (typeof child === 'string') continue
      if (child.name !== 'pubkey-metadata') continue
      // Prefer `v6-fingerprint` when present: it's the unambiguous
      // semantic name, and when both are emitted (as we do) they
      // carry the same value anyway. Falls back to `v4-fingerprint`
      // so peers that only emit the legacy attribute still resolve.
      const fp = firstAttr(child.attrs, ['v6-fingerprint', 'v4-fingerprint'])
      if (fp) fingerprints.push(fp)
    }
  }
  return fingerprints
}

/**
 * Parse a single `<pubkey xmlns='urn:xmpp:openpgp:0'><data>…</data></pubkey>`
 * item from a data node (XEP-0373 §4.1.2.1) and return the decoded
 * ASCII-armored OpenPGP key. Returns `null` when the element has the
 * wrong shape (missing `<data>` or a wrong namespace).
 *
 * Intentionally does NOT try to derive the fingerprint: the armor format
 * a peer ships is outside our control (legacy `Fingerprint:` header vs
 * RFC 9580 `Comment:` header vs no header at all), so we leave that to
 * the Rust side via `openpgp_fingerprint` where Sequoia understands
 * every variant.
 */
function parsePublicKeyDataItem(payload: XMLElementData): string | null {
  if (payload.name !== 'pubkey' || payload.attrs?.xmlns !== OX_NAMESPACE) return null
  // Find the `<data>` child — the spec wraps the base64 in this element
  // rather than putting the text directly under `<pubkey>`.
  for (const child of payload.children) {
    if (typeof child === 'string') continue
    if (child.name !== 'data') continue
    const encoded = firstText(child)
    if (encoded) return base64Decode(encoded)
  }
  return null
}

/**
 * Case-insensitive fingerprint comparison. The advertised value on the
 * PEP metadata node and the value we get back from Sequoia are both hex
 * strings with no separators, but nothing in the spec says they agree on
 * casing — normalize both sides before comparing.
 */
function fingerprintsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Parse a single `<secretkey xmlns='urn:xmpp:openpgp:0'><data>…</data></secretkey>`
 * PEP item (XEP-0373 §5.1). The wrapped `<data>` text is the base64 of
 * an armored OpenPGP message — return it decoded. `null` when the item
 * is shaped unexpectedly (wrong namespace, missing `<data>`).
 */
function parseSecretKeyBackupItem(payload: XMLElementData): string | null {
  if (payload.name !== 'secretkey' || payload.attrs?.xmlns !== OX_NAMESPACE) return null
  for (const child of payload.children) {
    if (typeof child === 'string') continue
    if (child.name !== 'data') continue
    const encoded = firstText(child)
    if (encoded) return base64Decode(encoded)
  }
  return null
}

/**
 * Return the first non-empty attribute value from `names` against
 * `attrs`. Used to read either `v4-fingerprint` (legacy spec name) or
 * `v6-fingerprint` (what newer clients may emit).
 */
function firstAttr(
  attrs: Record<string, unknown> | undefined,
  names: readonly string[],
): string | null {
  if (!attrs) return null
  for (const name of names) {
    const v = attrs[name]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return null
}

function firstText(el: XMLElementData): string | null {
  const child = el.children[0]
  return typeof child === 'string' ? child : null
}

function base64Encode(input: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(input)))
  return Buffer.from(input, 'utf-8').toString('base64')
}

function base64Decode(encoded: string): string {
  if (typeof atob === 'function') return decodeURIComponent(escape(atob(encoded)))
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
