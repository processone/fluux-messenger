/**
 * Trust-state integrity: a sealed copy of the trust decisions and the
 * verification-sync state (its version, and whether the set node was
 * adopted), to detect changes made to storage behind the plugin's back.
 *
 * The seal is the decisions encrypted to the account's own key, which also
 * signs them. It is rewritten after every change of a decision or of the sync
 * version, and checked once the key is usable. A seal that differs from the
 * records, or a missing seal once one was written, is reported as
 * `compromised`; the app then warns the user, who can reseal the current
 * state.
 *
 * The seal and the flag saying one was written live in the plugin's storage,
 * beside the records they protect. Earlier versions kept a seal over other
 * data in `localStorage`; `legacyTrustMigration.ts` checks that one.
 *
 * Reuses the encrypt-to-self pattern from {@link verificationSync.ts}.
 */

import type { PluginStorage } from '@fluux/sdk'
import { fingerprintsEqual } from './fingerprintCompare'
import type { KeyDecision, TrustStateVerdict } from './trustTypes'
import type { DecryptFn, EncryptFn } from './verificationSync'

/** Plugin storage key of the armored seal. */
export const TRUST_SEAL_STORAGE_KEY = 'trust-seal'
/** Plugin storage key of the flag saying a seal was written for this account. */
export const TRUST_SEAL_WRITTEN_STORAGE_KEY = 'trust-seal-written'

interface TrustStateSealPayload {
  v: 2
  sealedAt: string
  decisions: Record<string, Record<string, KeyDecision>>
  syncVersion: number
  setsAdopted: boolean
}

/**
 * What the seal covers, read from the records (`TrustRecordStore`) or from a
 * copy of them taken earlier ({@link copyTrustState}).
 */
export interface TrustStateReading {
  decisions(): Record<string, Record<string, KeyDecision>>
  syncVersion(): number
  setsAdopted(): boolean
}

/** A copy of what the seal covers, as the records hold it now. */
export function copyTrustState(records: TrustStateReading): TrustStateReading {
  const decisions = canonicalJson(records.decisions())
  const syncVersion = records.syncVersion()
  const setsAdopted = records.setsAdopted()
  return {
    decisions: () => JSON.parse(decisions) as Record<string, Record<string, KeyDecision>>,
    syncVersion: () => syncVersion,
    setsAdopted: () => setsAdopted,
  }
}

/** Whether two readings hold the same decisions and sync state. */
export function sameTrustState(a: TrustStateReading, b: TrustStateReading): boolean {
  return (
    canonicalJson(a.decisions()) === canonicalJson(b.decisions()) &&
    a.syncVersion() === b.syncVersion() &&
    a.setsAdopted() === b.setsAdopted()
  )
}

/** JSON with every object's keys sorted, at every depth. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decodeText(bytes: Uint8Array | null): string | null {
  return bytes ? new TextDecoder().decode(bytes) : null
}

/** Seal the records as they are now, or a copy of them. */
export async function sealTrustState(
  storage: PluginStorage,
  records: TrustStateReading,
  encryptFn: EncryptFn,
  ownPublicArmored: string,
): Promise<void> {
  const payload: TrustStateSealPayload = {
    v: 2,
    sealedAt: new Date().toISOString(),
    decisions: records.decisions(),
    syncVersion: records.syncVersion(),
    setsAdopted: records.setsAdopted(),
  }
  const armored = await encryptFn(JSON.stringify(payload), ownPublicArmored)
  await storage.put(TRUST_SEAL_STORAGE_KEY, encodeText(armored))
  await storage.put(TRUST_SEAL_WRITTEN_STORAGE_KEY, encodeText('1'))
}

/**
 * `decisions` without the holds saved since `sealed` was: keys held where it
 * records no decision. A hold only keeps a key from receiving messages until
 * the user decides, so a hold saved while nothing could be sealed (the check
 * waited for the key, or the session ended first) is not a change to report.
 * A hold that replaced a sealed decision, and a sealed hold that is gone,
 * still differ.
 */
export function withoutHoldsAddedSince(
  decisions: Record<string, Record<string, KeyDecision>>,
  sealed: Record<string, Record<string, KeyDecision>>,
): Record<string, Record<string, KeyDecision>> {
  const out: Record<string, Record<string, KeyDecision>> = {}
  for (const [peer, keys] of Object.entries(decisions)) {
    const sealedKeys: Record<string, unknown> = Object.hasOwn(sealed, peer) ? Object(sealed[peer]) : {}
    const kept = Object.entries(keys).filter(([fp, decision]) => decision !== 'held' || Object.hasOwn(sealedKeys, fp))
    if (kept.length > 0) out[peer] = Object.fromEntries(kept)
  }
  return out
}

/**
 * Compare the seal with the records, or with a copy of them. Holds saved
 * since the seal was written are accepted (see {@link withoutHoldsAddedSince})
 * and reported as `pending-seal`, so they are sealed at once and their removal
 * cannot go unnoticed later.
 */
export async function verifyTrustStateSeal(
  storage: PluginStorage,
  records: TrustStateReading,
  decryptFn: DecryptFn,
  ownPublicArmored: string,
  ownFingerprint: string,
  isKeyUnavailable: (err: unknown) => boolean = () => false,
): Promise<TrustStateVerdict> {
  const empty = Object.keys(records.decisions()).length === 0
  const sealArmored = decodeText(await storage.get(TRUST_SEAL_STORAGE_KEY))

  if (!sealArmored) {
    if (empty) return { status: 'uninitialized' }
    const written = decodeText(await storage.get(TRUST_SEAL_WRITTEN_STORAGE_KEY)) === '1'
    if (!written) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal was removed but trust records contain data'] }
  }

  let decrypted: Awaited<ReturnType<DecryptFn>>
  try {
    decrypted = await decryptFn(sealArmored, ownPublicArmored)
  } catch (err) {
    // A decrypt failure because the secret key is unavailable (locked or
    // unrecoverable) is not a tamper signal: there is no verdict yet. Only a
    // decrypt failure with a usable key is suspicious.
    if (isKeyUnavailable(err)) return { status: 'awaiting-key' }
    if (empty) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal could not be decrypted'] }
  }

  if (
    !decrypted.signatureVerified ||
    !decrypted.signerFingerprint ||
    !fingerprintsEqual(decrypted.signerFingerprint, ownFingerprint)
  ) {
    if (empty) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal has invalid or foreign signature'] }
  }

  let payload: TrustStateSealPayload
  try {
    payload = JSON.parse(decrypted.plaintext) as TrustStateSealPayload
    if (payload.v !== 2 || !payload.decisions || typeof payload.decisions !== 'object') {
      throw new Error('unknown version')
    }
  } catch {
    return { status: 'compromised', details: ['Trust state seal payload is malformed'] }
  }

  const details: string[] = []
  const decisions = records.decisions()
  const sealedDecisions = withoutHoldsAddedSince(decisions, payload.decisions)
  if (canonicalJson(payload.decisions) !== canonicalJson(sealedDecisions)) details.push('trust decisions differ')
  if (payload.syncVersion !== records.syncVersion()) details.push('verification sync version differs')
  if ((payload.setsAdopted === true) !== records.setsAdopted()) details.push('verification sync format differs')
  if (details.length > 0) return { status: 'compromised', details }
  return canonicalJson(sealedDecisions) === canonicalJson(decisions) ? { status: 'sealed' } : { status: 'pending-seal' }
}
