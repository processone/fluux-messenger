import type { PluginStorage } from '@fluux/sdk'
import type { OmemoStore, IdentityRecord, SignedPreKeyRecord, PreKeyRecord, SessionRecord, TrustRecord } from '@fluux/omemo'
import { b64encode, b64decode } from '@fluux/omemo'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Tag used to mark a base64-encoded Uint8Array field inside the JSON codec. */
interface EncodedBytes {
  __u8: string
}

function isEncodedBytes(v: unknown): v is EncodedBytes {
  return typeof v === 'object' && v !== null && typeof (v as { __u8?: unknown }).__u8 === 'string'
}

const toBytes = (o: unknown): Uint8Array =>
  enc.encode(JSON.stringify(o, (_k, v) => (v instanceof Uint8Array ? { __u8: b64encode(v) } : v)))

const fromBytes = <T>(b: Uint8Array): T =>
  JSON.parse(dec.decode(b), (_k, v) => (isEncodedBytes(v) ? b64decode(v.__u8) : v)) as T

const spkKey = (id: number) => `spk/${id}`
const pkKey = (id: number) => `pk/${id}`
const sessKey = (peer: string, deviceId: number) => `session/${peer}/${deviceId}`
const trustKey = (peer: string, deviceId: number) => `trust/${peer}/${deviceId}`

/**
 * `OmemoStore` implementation backed by a host-provided `PluginStorage`.
 *
 * `SessionRecord` is already an opaque `Uint8Array` (serialized Double-Ratchet
 * state), so it is written verbatim. Every other record holds `Uint8Array`
 * fields nested inside a plain object, so those are serialized with a small
 * JSON codec that base64-encodes `Uint8Array` values.
 */
export class PluginStorageOmemoStore implements OmemoStore {
  constructor(private readonly storage: PluginStorage) {}

  private async loadRecord<T>(key: string): Promise<T | null> {
    const bytes = await this.storage.get(key)
    return bytes ? fromBytes<T>(bytes) : null
  }

  private async saveRecord(key: string, record: unknown): Promise<void> {
    await this.storage.put(key, toBytes(record))
  }

  loadIdentity(): Promise<IdentityRecord | null> {
    return this.loadRecord<IdentityRecord>('identity')
  }

  saveIdentity(r: IdentityRecord): Promise<void> {
    return this.saveRecord('identity', r)
  }

  loadSignedPreKey(id: number): Promise<SignedPreKeyRecord | null> {
    return this.loadRecord<SignedPreKeyRecord>(spkKey(id))
  }

  saveSignedPreKey(id: number, r: SignedPreKeyRecord): Promise<void> {
    return this.saveRecord(spkKey(id), r)
  }

  loadPreKey(id: number): Promise<PreKeyRecord | null> {
    return this.loadRecord<PreKeyRecord>(pkKey(id))
  }

  savePreKey(id: number, r: PreKeyRecord): Promise<void> {
    return this.saveRecord(pkKey(id), r)
  }

  async removePreKey(id: number): Promise<void> {
    await this.storage.delete(pkKey(id))
  }

  async loadSession(peer: string, deviceId: number): Promise<SessionRecord | null> {
    return this.storage.get(sessKey(peer, deviceId))
  }

  async saveSession(peer: string, deviceId: number, s: SessionRecord): Promise<void> {
    await this.storage.put(sessKey(peer, deviceId), s)
  }

  loadTrust(peer: string, deviceId: number): Promise<TrustRecord | null> {
    return this.loadRecord<TrustRecord>(trustKey(peer, deviceId))
  }

  saveTrust(peer: string, deviceId: number, t: TrustRecord): Promise<void> {
    return this.saveRecord(trustKey(peer, deviceId), t)
  }
}
