export interface IdentityRecord {
  edSeed: Uint8Array // 32-byte Ed25519 seed (private)
  edPub: Uint8Array // 32-byte Ed25519 public
  deviceId: number
}
export interface SignedPreKeyRecord {
  id: number
  priv: Uint8Array // X25519 private
  pub: Uint8Array // X25519 public
  signature: Uint8Array // Ed25519 signature over pub
}
export interface PreKeyRecord {
  id: number
  priv: Uint8Array
  pub: Uint8Array
}
/** Opaque serialized Double-Ratchet session state (produced/consumed by ratchet.ts). */
export type SessionRecord = Uint8Array
export interface TrustRecord {
  state: 'untrusted' | 'trusted' | 'undecided'
  identityKey: Uint8Array // remote Ed25519 IK bound to this device
}

/**
 * Persistence boundary for OMEMO state. The library holds no at-rest state of
 * its own — callers inject a store implementation. Encryption-at-rest (if
 * any) is the concern of the store implementation, not this library.
 */
export interface OmemoStore {
  loadIdentity(): Promise<IdentityRecord | null>
  saveIdentity(r: IdentityRecord): Promise<void>

  loadSignedPreKey(id: number): Promise<SignedPreKeyRecord | null>
  saveSignedPreKey(id: number, r: SignedPreKeyRecord): Promise<void>

  loadPreKey(id: number): Promise<PreKeyRecord | null>
  savePreKey(id: number, r: PreKeyRecord): Promise<void>
  removePreKey(id: number): Promise<void>

  loadSession(peer: string, deviceId: number): Promise<SessionRecord | null>
  saveSession(peer: string, deviceId: number, s: SessionRecord): Promise<void>

  loadTrust(peer: string, deviceId: number): Promise<TrustRecord | null>
  saveTrust(peer: string, deviceId: number, t: TrustRecord): Promise<void>
}
