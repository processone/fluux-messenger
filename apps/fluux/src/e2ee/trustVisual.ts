import type { TrustState } from '@fluux/sdk'

/**
 * The single source of truth for the COLOR of an E2EE trust indicator.
 *
 * "Calm by default": routine states (TOFU, your own un-entered passphrase,
 * plaintext, an in-flight probe) are neutral gray; verified is the teal
 * encryption brand color; only a genuine anomaly (a message that could not be
 * decrypted, a rotated peer key, a forged signature) is yellow or red.
 *
 * Returns COLOR and tone only. The icon stays the responsibility of each
 * surface, because the inline per-message lock (compact Lock) and the header
 * affordance (prominent Shield) are deliberately different glyphs.
 */
export type TrustTone = 'verified' | 'calm' | 'warning' | 'danger'

export type TrustVisualState =
  | 'verified'      // out-of-band-confirmed peer key
  | 'trusted'       // tofu / tofu-new / introduced / encrypted-unverified
  | 'decryptFailed' // per-message untrusted: could not decrypt this message
  | 'rejected'      // forged or absent signature
  | 'keyChanged'    // peer key rotated, encryption blocked pending acceptance
  | 'keyLocked'     // the user's own key passphrase is not entered (friction, not a threat)
  | 'plaintext'     // not encrypted / unsupported / user-forced cleartext
  | 'checking'      // encryption probe in flight

export interface TrustVisual {
  colorClass: string
  tone: TrustTone
}

export function trustVisual(state: TrustVisualState): TrustVisual {
  switch (state) {
    case 'verified':
      return { colorClass: 'text-fluux-encryption', tone: 'verified' }
    case 'decryptFailed':
    case 'keyChanged':
      return { colorClass: 'text-fluux-yellow', tone: 'warning' }
    case 'rejected':
      return { colorClass: 'text-fluux-error', tone: 'danger' }
    case 'trusted':
    case 'keyLocked':
    case 'plaintext':
    case 'checking':
      return { colorClass: 'text-fluux-muted', tone: 'calm' }
  }
}

/**
 * The single source of truth for the COLOR + TONE of a consumer-facing
 * {@link TrustState} (peer/device/aggregate trust). Distinct from
 * {@link trustVisual}, which keys on the message-lock / cert PRESENTATION
 * states (`decryptFailed`, `keyChanged`, `rejected`, …) — those are not trust
 * levels. "Calm by default": only `untrusted` (a new/changed/failed key) is a
 * danger signal; `verified` is the teal brand; everything else is neutral.
 */
export function trustStateVisual(t: TrustState): TrustVisual {
  switch (t) {
    case 'verified':
      return { colorClass: 'text-fluux-encryption', tone: 'verified' }
    case 'untrusted':
      return { colorClass: 'text-fluux-error', tone: 'danger' }
    case 'tofu':
    case 'introduced':
    case 'unknown':
      return { colorClass: 'text-fluux-muted', tone: 'calm' }
  }
}

/** i18n key for a {@link TrustState}'s human label. Caller wraps in `t(...)`. */
export function trustLabel(t: TrustState): string {
  return `contacts.encryption.trust.${t}`
}
