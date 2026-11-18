/**
 * Trust-state integrity: a sealed copy of the trust decisions and the
 * verification-sync version, to detect changes made to storage behind the
 * plugin's back.
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
import type { TrustRecordStore } from './trustRecords'
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

/** Seal the records as they are now. */
export async function sealTrustState(
  storage: PluginStorage,
  records: TrustRecordStore,
  encryptFn: EncryptFn,
  ownPublicArmored: string,
): Promise<void> {
  const payload: TrustStateSealPayload = {
    v: 2,
    sealedAt: new Date().toISOString(),
    decisions: records.decisions(),
    syncVersion: records.syncVersion(),
  }
  const armored = await encryptFn(JSON.stringify(payload), ownPublicArmored)
  await storage.put(TRUST_SEAL_STORAGE_KEY, encodeText(armored))
  await storage.put(TRUST_SEAL_WRITTEN_STORAGE_KEY, encodeText('1'))
}

/** Compare the seal with the records. */
export async function verifyTrustStateSeal(
  storage: PluginStorage,
  records: TrustRecordStore,
  decryptFn: DecryptFn,
  ownPublicArmored: string,
  ownFingerprint: string,
  isKeyUnavailable: (err: unknown) => boolean = () => false,
): Promise<TrustStateVerdict> {
  const empty = !records.hasDecisions()
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
  if (canonicalJson(payload.decisions) !== canonicalJson(records.decisions())) details.push('trust decisions differ')
  if (payload.syncVersion !== records.syncVersion()) details.push('verification sync version differs')
  return details.length > 0 ? { status: 'compromised', details } : { status: 'sealed' }
}
