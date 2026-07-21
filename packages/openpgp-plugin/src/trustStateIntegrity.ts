/**
 * Trust-state integrity: signed blob protecting TOFU pins, verified
 * peers, key-change alerts, and the verification sync counter against
 * tampering with the plugin's persisted state.
 *
 * The blob is sealed (encrypt-to-self, which also signs) after every
 * trust-store mutation, and verified on plugin init once the key is
 * available. A mismatch between the blob and the current stores — or
 * an absent blob when one was previously written — enters
 * "trust-state-compromised" mode, blocking silent TOFU re-pinning and
 * surfacing a strong user warning.
 *
 * Reuses the encrypt-to-self pattern from {@link verificationSync.ts}.
 *
 * B3 Task 5: the sealed blob and its "we have sealed before" init flag moved
 * from two `localStorage` keys into the plugin's `PluginStorage` — see
 * `legacyTrustStateSeed.ts` for the one-shot upgrade path that copies
 * existing users' data across. The read/write sites here (`sealTrustState`,
 * `verifyTrustStateSeal`, `clearCompromisedAndReseal`) all take a `storage:
 * PluginStorage` parameter now; every call site was already inside an
 * `async` function (verified in the B1 grounding), so this doesn't force any
 * new awaits onto a caller that wasn't already async. `buildCanonicalSnapshot`
 * itself never touched seal storage and stays synchronous, unaffected.
 */

import type { PluginStorage } from '@fluux/sdk'
import type { OpenPGPHostStores, TrustStateStatus } from './hostStores'
import { loadAppliedVerificationsVersion } from './verificationSync'
import type { EncryptFn, DecryptFn } from './verificationSync'

/**
 * `PluginStorage` keys (B3 Task 5). Unlike the pre-Task-5 `localStorage`
 * keys, these need no account scoping: the host hands each plugin a
 * `PluginStorage` view already namespaced per plugin AND per account (see
 * `E2EEManager.register`'s `e2ee/${id}` prefix over an account-scoped
 * backend), so two accounts — or two plugins — can never collide here.
 */
export const SEAL_STORAGE_KEY = 'trust-state-seal'
export const INIT_FLAG_STORAGE_KEY = 'trust-integrity-init'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function readSeal(storage: PluginStorage): Promise<string | null> {
  const bytes = await storage.get(SEAL_STORAGE_KEY)
  if (!bytes) return null
  try {
    return dec.decode(bytes)
  } catch {
    return null
  }
}

/**
 * Raw, un-caught write of the seal blob bytes. Exported for
 * `legacyTrustStateSeed.ts`'s migration, which needs the rejection to
 * propagate (so a failed persist leaves the legacy keys in place) rather
 * than being swallowed the way {@link sealTrustState}'s own call site
 * swallows it.
 */
export async function writeSealBytes(storage: PluginStorage, armored: string): Promise<void> {
  await storage.put(SEAL_STORAGE_KEY, enc.encode(armored))
}

async function isInitialized(storage: PluginStorage): Promise<boolean> {
  const bytes = await storage.get(INIT_FLAG_STORAGE_KEY)
  if (!bytes) return false
  try {
    return dec.decode(bytes) === '1'
  } catch {
    return false
  }
}

/** Raw, un-caught write of the init flag — see {@link writeSealBytes}. */
export async function writeInitFlag(storage: PluginStorage): Promise<void> {
  await storage.put(INIT_FLAG_STORAGE_KEY, enc.encode('1'))
}

/**
 * Whether `storage` already holds a sealed blob. Used by the legacy-seed
 * migration to guard against re-seeding (and re-removing legacy keys) once
 * the plugin owns real data — mirrors `SyncVersionCache`'s `get() !== -1`
 * guard and `VerifiedKeysCache`'s "already populated" guard.
 */
export async function hasStoredSeal(storage: PluginStorage): Promise<boolean> {
  return (await readSeal(storage)) !== null
}

interface TrustStateSnapshot {
  v: 1
  sealedAt: string
  pins: Record<string, string>
  verified: Record<string, string>
  alerts: Record<string, { previousFingerprint: string; currentFingerprint: string; observedAt: string }>
  syncVersion: number
}

let lastKnownPayload: TrustStateSnapshot | null = null

function sortedStringify(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort())
}

export function buildCanonicalSnapshot(
  hostStores: OpenPGPHostStores,
  verified: Record<string, string>,
): TrustStateSnapshot {
  const pins = { ...hostStores.pinnedPrimaryFingerprints.getAll() }
  const alerts = { ...hostStores.keyChangeAlerts.getAll() }
  const syncVersion = loadAppliedVerificationsVersion()
  return { v: 1, sealedAt: new Date().toISOString(), pins, verified: { ...verified }, alerts, syncVersion }
}

function payloadsMatch(a: TrustStateSnapshot, b: TrustStateSnapshot): { match: boolean; details: string[] } {
  const details: string[] = []
  if (sortedStringify(a.pins) !== sortedStringify(b.pins)) details.push('pinned fingerprints differ')
  if (sortedStringify(a.verified) !== sortedStringify(b.verified)) details.push('verified peers differ')
  if (sortedStringify(a.alerts) !== sortedStringify(b.alerts)) details.push('key-change alerts differ')
  if (a.syncVersion !== b.syncVersion) details.push('verification sync version differs')
  return { match: details.length === 0, details }
}

function storesAreEmpty(hostStores: OpenPGPHostStores, verified: Record<string, string>): boolean {
  const pins = hostStores.pinnedPrimaryFingerprints.getAll()
  const alerts = hostStores.keyChangeAlerts.getAll()
  return (
    Object.keys(pins).length === 0 &&
    Object.keys(verified).length === 0 &&
    Object.keys(alerts).length === 0
  )
}

/**
 * Seal the current trust state and persist it, plus the "we have sealed
 * before" init flag, to `storage`. Best-effort: a persistence failure
 * (quota exceeded, backend unavailable) is swallowed here, matching the
 * pre-B3-Task-5 `localStorage` version's own catch — both of this
 * function's call sites (`sealTrustStateNow` / `clearCompromisedAndReseal`'s
 * caller) already wrap it in their own best-effort handling, so there is no
 * caller here that would do anything useful with the rejection.
 */
export async function sealTrustState(
  encryptFn: EncryptFn,
  ownPublicArmored: string,
  hostStores: OpenPGPHostStores,
  verified: Record<string, string>,
  storage: PluginStorage,
): Promise<void> {
  const snapshot = buildCanonicalSnapshot(hostStores, verified)
  const json = JSON.stringify(snapshot)
  const armored = await encryptFn(json, ownPublicArmored)
  try {
    await writeSealBytes(storage, armored)
    await writeInitFlag(storage)
  } catch {
    // best-effort — quota exceeded etc.
  }
}

function fingerprintsEqual(a: string, b: string): boolean {
  return a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase()
}

export async function verifyTrustStateSeal(
  decryptFn: DecryptFn,
  ownPublicArmored: string,
  ownFingerprint: string,
  hostStores: OpenPGPHostStores,
  verified: Record<string, string>,
  storage: PluginStorage,
  isKeyUnavailable: (err: unknown) => boolean = () => false,
): Promise<{ status: TrustStateStatus; details?: string[] }> {
  const sealArmored = await readSeal(storage)

  if (!sealArmored) {
    if (storesAreEmpty(hostStores, verified)) return { status: 'uninitialized' }
    if (!(await isInitialized(storage))) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal was removed but stores contain data'] }
  }

  let decrypted: Awaited<ReturnType<DecryptFn>>
  try {
    decrypted = await decryptFn(sealArmored, ownPublicArmored)
  } catch (err) {
    // A decrypt failure because the secret key is unavailable (locked /
    // unrecoverable) is NOT a tamper signal — there is simply no
    // verdict yet. Only a decrypt failure with a usable key is suspicious.
    if (isKeyUnavailable(err)) return { status: 'awaiting-key' }
    if (storesAreEmpty(hostStores, verified)) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal could not be decrypted'] }
  }

  if (
    !decrypted.signatureVerified ||
    !decrypted.signerFingerprint ||
    !fingerprintsEqual(decrypted.signerFingerprint, ownFingerprint)
  ) {
    if (storesAreEmpty(hostStores, verified)) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal has invalid or foreign signature'] }
  }

  let payload: TrustStateSnapshot
  try {
    payload = JSON.parse(decrypted.plaintext)
    if (payload.v !== 1) throw new Error('unknown version')
  } catch {
    return { status: 'compromised', details: ['Trust state seal payload is malformed'] }
  }

  lastKnownPayload = payload

  const current = buildCanonicalSnapshot(hostStores, verified)
  const { match, details } = payloadsMatch(payload, current)
  if (!match) {
    return { status: 'compromised', details }
  }

  return { status: 'sealed' }
}

export function isTofuBlockedByCompromise(peer: string, hostStores: OpenPGPHostStores): boolean {
  if (hostStores.trustStateStatus.get() !== 'compromised') return false
  if (!lastKnownPayload) return true
  return peer in lastKnownPayload.pins
}

export async function clearCompromisedAndReseal(
  encryptFn: EncryptFn,
  ownPublicArmored: string,
  hostStores: OpenPGPHostStores,
  verified: Record<string, string>,
  storage: PluginStorage,
): Promise<void> {
  await sealTrustState(encryptFn, ownPublicArmored, hostStores, verified, storage)
  lastKnownPayload = null
  hostStores.trustStateStatus.set('sealed')
}
