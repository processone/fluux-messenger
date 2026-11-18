/**
 * In-memory {@link OpenPGPHostStores} for the package's own tests.
 *
 * Mirrors the contract in `hostStores.ts`: `subscribe` listeners run
 * synchronously inside the write that changed a map, once per change, and not
 * for a write of the same value.
 */
import type {
  CertRejection,
  HostMapListener,
  KeyChangeAlert,
  OpenPGPHostStores,
  OwnKeyConflict,
  TrustStateStatus,
} from '../hostStores'

export interface MockHostStores extends OpenPGPHostStores {
  /** Replace the verified-peers map, notifying subscribers. */
  setVerifiedPeers(map: Record<string, string>): void
  setPins(map: Record<string, string>): void
  setKeyChangeAlerts(map: Record<string, KeyChangeAlert>): void
  /** Details given with the latest trust-state status, if any. */
  trustStateDetails(): string[] | undefined
  /** How many times `peerKeysets.notifyChanged` ran for a peer. */
  peerKeysetNotifications(jid: string): number
  /** Reset every group to empty. */
  reset(): void
}

class ObservedMap<T> {
  private map: Record<string, T> = {}
  private listeners = new Set<HostMapListener<T>>()

  get(): Readonly<Record<string, T>> { return this.map }

  replace(next: Record<string, T>): void {
    const prev = this.map
    this.map = next
    for (const listener of [...this.listeners]) listener(next, prev)
  }

  subscribe(listener: HostMapListener<T>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export function createMockHostStores(): MockHostStores {
  const verified = new ObservedMap<string>()
  const pins = new ObservedMap<string>()
  const alerts = new ObservedMap<KeyChangeAlert>()
  let rejections: Record<string, CertRejection[]> = {}
  let conflict: OwnKeyConflict | null = null
  let status: TrustStateStatus = 'uninitialized'
  let details: string[] | undefined
  let notified: Record<string, number> = {}

  const norm = (fp: string) => fp.replace(/\s+/g, '').toLowerCase()
  const withKey = <T,>(map: Readonly<Record<string, T>>, jid: string, value: T) => ({ ...map, [jid]: value })
  const without = <T,>(map: Readonly<Record<string, T>>, jid: string) => {
    const { [jid]: _drop, ...rest } = map
    return rest
  }

  return {
    verifiedPeers: {
      isVerified: (jid, fp) => {
        const v = verified.get()[jid]
        return v !== undefined && norm(v) === norm(fp)
      },
      set: (jid, fp) => { if (verified.get()[jid] !== fp) verified.replace(withKey(verified.get(), jid, fp)) },
      clear: (jid) => { if (jid in verified.get()) verified.replace(without(verified.get(), jid)) },
      getAll: () => verified.get(),
      subscribe: (l) => verified.subscribe(l),
    },
    certRejections: {
      record: (jid, list) => { rejections = { ...rejections, [jid]: list } },
      clear: (jid) => { rejections = without(rejections, jid) },
      get: (jid) => rejections[jid] ?? [],
    },
    keyChangeAlerts: {
      get: (jid) => alerts.get()[jid] ?? null,
      clear: (jid) => { if (jid in alerts.get()) alerts.replace(without(alerts.get(), jid)) },
      getAll: () => alerts.get(),
      subscribe: (l) => alerts.subscribe(l),
    },
    ownKeyConflict: {
      record: (c) => { conflict = c },
      clear: () => { conflict = null },
      get: () => conflict,
    },
    pinnedPrimaryFingerprints: {
      set: (jid, fp) => { if (pins.get()[jid] !== fp) pins.replace(withKey(pins.get(), jid, fp)) },
      getAll: () => pins.get(),
      subscribe: (l) => pins.subscribe(l),
    },
    trustStateStatus: {
      set: (s, d) => { status = s; details = d },
      get: () => status,
    },
    peerKeysets: { notifyChanged: (jid) => { notified = { ...notified, [jid]: (notified[jid] ?? 0) + 1 } } },
    trustStateDetails: () => details,
    peerKeysetNotifications: (jid) => notified[jid] ?? 0,
    setVerifiedPeers: (m) => verified.replace(m),
    setPins: (m) => pins.replace(m),
    setKeyChangeAlerts: (m) => alerts.replace(m),
    reset: () => {
      verified.replace({}); pins.replace({}); alerts.replace({})
      rejections = {}; conflict = null; status = 'uninitialized'; details = undefined; notified = {}
    },
  }
}
