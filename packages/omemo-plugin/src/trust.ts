import type { TrustState } from '@fluux/sdk'

/**
 * Persisted per-device trust decision (stored in `@fluux/omemo`'s `TrustRecord.state`).
 *
 * Note: explicit out-of-band fingerprint verification is tracked by a separate marker
 * (set by the verification flow) and is not represented here — see Task 10.
 */
export type BtbvState = 'undecided' | 'trusted' | 'untrusted'

/**
 * Blind-Trust-Before-Verification (BTBV) decision for a newly-seen device.
 *
 * - Before the user has verified any of a peer's devices, new devices are auto-accepted
 *   (blind-trusted) so messaging just works.
 * - Once the peer has a verified device, subsequently-unseen devices are untrusted until
 *   explicitly verified.
 * - An existing explicit decision (anything other than 'undecided') is kept, not re-derived.
 */
export function resolveInboundTrust(
  peerHasVerifiedDevice: boolean,
  existing: BtbvState | null,
): { store: BtbvState; surfaced: TrustState } {
  if (existing && existing !== 'undecided') {
    return { store: existing, surfaced: toTrustState(existing) }
  }
  const store: BtbvState = peerHasVerifiedDevice ? 'untrusted' : 'trusted'
  return { store, surfaced: toTrustState(store) }
}

export function toTrustState(s: BtbvState): TrustState {
  switch (s) {
    case 'trusted':
      return 'tofu'
    case 'untrusted':
      return 'untrusted'
    default:
      return 'unknown'
  }
}
