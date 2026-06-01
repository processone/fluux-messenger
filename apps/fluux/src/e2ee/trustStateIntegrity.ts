/**
 * Trust-state integrity: signed blob protecting TOFU pins, verified
 * peers, key-change alerts, and the verification sync counter against
 * localStorage tampering.
 *
 * The blob is sealed (encrypt-to-self, which also signs) after every
 * trust-store mutation, and verified on plugin init once the key is
 * available. A mismatch between the blob and the current stores — or
 * an absent blob when one was previously written — enters
 * "trust-state-compromised" mode, blocking silent TOFU re-pinning and
 * surfacing a strong user warning.
 *
 * Reuses the encrypt-to-self pattern from {@link verificationSync.ts}.
 */

import { buildScopedStorageKey } from '@fluux/sdk'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { setTrustStateStatus, getTrustStateStatus } from '@/stores/trustStateStatusStore'
import type { TrustStateStatus } from '@/stores/trustStateStatusStore'
import { loadAppliedVerificationsVersion } from './verificationSync'
import type { EncryptFn, DecryptFn } from './verificationSync'

const SEAL_STORAGE_KEY_BASE = 'fluux-e2ee-trust-state-seal'
const INIT_FLAG_KEY_BASE = 'fluux-e2ee-trust-integrity-init'

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

export function buildCanonicalSnapshot(): TrustStateSnapshot {
  const pins = { ...usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid }
  const verified = { ...useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid }
  const alerts = { ...useKeyChangeAlertsStore.getState().alertsByJid }
  const syncVersion = loadAppliedVerificationsVersion()
  return { v: 1, sealedAt: new Date().toISOString(), pins, verified, alerts, syncVersion }
}

function payloadsMatch(a: TrustStateSnapshot, b: TrustStateSnapshot): { match: boolean; details: string[] } {
  const details: string[] = []
  if (sortedStringify(a.pins) !== sortedStringify(b.pins)) details.push('pinned fingerprints differ')
  if (sortedStringify(a.verified) !== sortedStringify(b.verified)) details.push('verified peers differ')
  if (sortedStringify(a.alerts) !== sortedStringify(b.alerts)) details.push('key-change alerts differ')
  if (a.syncVersion !== b.syncVersion) details.push('verification sync version differs')
  return { match: details.length === 0, details }
}

function storesAreEmpty(): boolean {
  const pins = usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid
  const verified = useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid
  const alerts = useKeyChangeAlertsStore.getState().alertsByJid
  return (
    Object.keys(pins).length === 0 &&
    Object.keys(verified).length === 0 &&
    Object.keys(alerts).length === 0
  )
}

function getSealKey(): string {
  return buildScopedStorageKey(SEAL_STORAGE_KEY_BASE)
}

function getInitFlagKey(): string {
  return buildScopedStorageKey(INIT_FLAG_KEY_BASE)
}

function isInitialized(): boolean {
  try {
    return localStorage.getItem(getInitFlagKey()) === '1'
  } catch {
    return false
  }
}

function markInitialized(): void {
  try {
    localStorage.setItem(getInitFlagKey(), '1')
  } catch {
    // best-effort
  }
}

export async function sealTrustState(
  encryptFn: EncryptFn,
  ownPublicArmored: string,
): Promise<void> {
  const snapshot = buildCanonicalSnapshot()
  const json = JSON.stringify(snapshot)
  const armored = await encryptFn(json, ownPublicArmored)
  try {
    localStorage.setItem(getSealKey(), armored)
    markInitialized()
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
): Promise<{ status: TrustStateStatus; details?: string[] }> {
  const sealArmored = localStorage.getItem(getSealKey())

  if (!sealArmored) {
    if (storesAreEmpty()) return { status: 'uninitialized' }
    if (!isInitialized()) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal was removed but stores contain data'] }
  }

  let decrypted: Awaited<ReturnType<DecryptFn>>
  try {
    decrypted = await decryptFn(sealArmored, ownPublicArmored)
  } catch {
    if (storesAreEmpty()) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal could not be decrypted'] }
  }

  if (
    !decrypted.signatureVerified ||
    !decrypted.signerFingerprint ||
    !fingerprintsEqual(decrypted.signerFingerprint, ownFingerprint)
  ) {
    if (storesAreEmpty()) return { status: 'pending-seal' }
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

  const current = buildCanonicalSnapshot()
  const { match, details } = payloadsMatch(payload, current)
  if (!match) {
    return { status: 'compromised', details }
  }

  return { status: 'sealed' }
}

export function isTofuBlockedByCompromise(peer: string): boolean {
  if (getTrustStateStatus() !== 'compromised') return false
  if (!lastKnownPayload) return true
  return peer in lastKnownPayload.pins
}

export async function clearCompromisedAndReseal(
  encryptFn: EncryptFn,
  ownPublicArmored: string,
): Promise<void> {
  await sealTrustState(encryptFn, ownPublicArmored)
  lastKnownPayload = null
  setTrustStateStatus('sealed')
}

export function resetTrustStateIntegrity(): void {
  lastKnownPayload = null
  setTrustStateStatus('uninitialized')
}
