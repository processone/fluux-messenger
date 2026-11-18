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
  | TrustState      // every state the SDK reports for an identity or a conversation
  | 'trusted'       // encrypted and not verified: tofu, a new contact, a partly verified one
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
    case 'untrusted':
      return { colorClass: 'text-fluux-error', tone: 'danger' }
    case 'trusted':
    case 'tofu':
    case 'introduced':
    case 'unknown':
    case 'keyLocked':
    case 'plaintext':
    case 'checking':
      return { colorClass: 'text-fluux-muted', tone: 'calm' }
  }
}
