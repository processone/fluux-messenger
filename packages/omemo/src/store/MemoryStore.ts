import type {
  OmemoStore,
  IdentityRecord,
  SignedPreKeyRecord,
  PreKeyRecord,
  SessionRecord,
  TrustRecord,
} from './types'

/**
 * In-memory `OmemoStore` implementation. Records are stored as opaque
 * values — never deep-cloned, frozen, or otherwise transformed — so it is
 * only suitable as a test double / ephemeral store, not for production
 * persistence.
 */
export class MemoryStore implements OmemoStore {
  private identity: IdentityRecord | null = null
  private signedPreKeys = new Map<number, SignedPreKeyRecord>()
  private preKeys = new Map<number, PreKeyRecord>()
  private sessions = new Map<string, SessionRecord>()
  private trust = new Map<string, TrustRecord>()

  private key(peer: string, deviceId: number): string {
    return `${peer}::${deviceId}`
  }

  async loadIdentity(): Promise<IdentityRecord | null> {
    return this.identity
  }
  async saveIdentity(r: IdentityRecord): Promise<void> {
    this.identity = r
  }

  async loadSignedPreKey(id: number): Promise<SignedPreKeyRecord | null> {
    return this.signedPreKeys.get(id) ?? null
  }
  async saveSignedPreKey(id: number, r: SignedPreKeyRecord): Promise<void> {
    this.signedPreKeys.set(id, r)
  }

  async loadPreKey(id: number): Promise<PreKeyRecord | null> {
    return this.preKeys.get(id) ?? null
  }
  async savePreKey(id: number, r: PreKeyRecord): Promise<void> {
    this.preKeys.set(id, r)
  }
  async removePreKey(id: number): Promise<void> {
    this.preKeys.delete(id)
  }

  async loadSession(peer: string, deviceId: number): Promise<SessionRecord | null> {
    return this.sessions.get(this.key(peer, deviceId)) ?? null
  }
  async saveSession(peer: string, deviceId: number, s: SessionRecord): Promise<void> {
    this.sessions.set(this.key(peer, deviceId), s)
  }

  async loadTrust(peer: string, deviceId: number): Promise<TrustRecord | null> {
    return this.trust.get(this.key(peer, deviceId)) ?? null
  }
  async saveTrust(peer: string, deviceId: number, t: TrustRecord): Promise<void> {
    this.trust.set(this.key(peer, deviceId), t)
  }
}
