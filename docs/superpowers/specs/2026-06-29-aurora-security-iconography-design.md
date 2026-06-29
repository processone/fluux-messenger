# Aurora Security Iconography: Design Spec

- Status: Approved (design), pending spec review
- Date: 2026-06-29
- Scope: `apps/fluux`. Consolidate the E2EE trust-lock iconography behind one tokenized resolver, unify the `verified` color, and calm one over-alarming non-threat. Effort S to M.
- Builds on: the merged theme audit (PR #674) and cross-theme contrast work (PR #700); uses the existing Aurora color tokens.

## Goal

The E2EE trust UI is already mostly "calm by default": routine TOFU renders gray, verified renders a positive color, and real key-change / compromise / forged-signature render yellow or red. But the rules are duplicated across every surface with no single source of truth, several surfaces hardcode bare Tailwind palette classes instead of the existing tokens, the `verified` state is teal on two surfaces and green on a third, and one state alarms a non-threat. This pass introduces a single tokenized trust-visual resolver, unifies `verified` on the encryption brand color, and calms the one non-threat, without changing any genuinely-alarming state.

## Background: current state (recon-confirmed)

The trust model (SDK `core/e2ee/types.ts`): per-message `MessageSecurityContext.trust` is `verified | introduced | tofu | untrusted | rejected`. The app's `resolveDisplayTrust` (`apps/fluux/src/components/conversation/messageTrust.ts`) resolves a signature-verified message to `verified` (live-verified fingerprint match) or `tofu` (otherwise), both calm; only baked `untrusted` and `rejected` pass through. Crucially, the SDK bakes per-message `untrusted` ONLY on a decrypt failure (`stanzaDecrypt.ts:331`, "could not decrypt: malformed / session-needs-repair / key-locked") and `rejected` only on a forged signature (line 259). So a routine new contact whose messages decrypt and verify renders gray `tofu`; the yellow `untrusted` lock fires on a genuine "could not decrypt this message" anomaly, where a soft signal is correct.

Current rendering (recon):
- Per-message lock (`MessageBubble.tsx`): verified teal (`text-fluux-encryption`), tofu gray (`text-fluux-muted`), untrusted yellow (`text-yellow-500`), rejected red (`text-red-500`).
- Chat-header encryption icon (`ChatHeader.tsx`): verified teal, tofu/tofu-new gray, blocked yellow (`var(--fluux-status-warning)`), rejected red (`text-red-500`), keyLocked yellow (`text-yellow-500`), plaintext/checking gray.
- Security tab (`SecurityTab.tsx`): verified GREEN (`text-green-600 dark:text-green-400`), tofu gray, blocked yellow (`text-yellow-600 dark:...`), rejected red (`text-red-600 dark:...`).
- Banners and key dialogs (KeyChangeBanner, OwnKeyConflictBanner, TrustStateCompromisedBanner, DeleteOpenpgpKeyDialog, IdentityChoiceDialog, Backup/RestorePassphraseDialog, VerifyPeerDialog, UnlockEncryptionDialog): correctly alarming or destructive-action UI, but hardcode bare `yellow/red/green` palette classes.

No shared trust-to-visual mapping exists; each surface hardcodes its own. Existing tokens available: `--fluux-text-encryption` (teal verified lock), `--fluux-text-muted` (gray), `--fluux-status-warning` (yellow, Tailwind `text-fluux-yellow`), `--fluux-text-error` (red text) and `--fluux-status-error` (red fill, Tailwind `bg-fluux-red`).

## Design

### 1. The single source of truth: `trustVisual`

A small pure module `apps/fluux/src/e2ee/trustVisual.ts` mapping a normalized trust-visual state to a color token plus a tone. The three trust-lock surfaces consume it, so the calm-by-default rules live in one place and a guard test pins them.

```ts
export type TrustTone = 'verified' | 'calm' | 'warning' | 'danger'

export type TrustVisualState =
  | 'verified'       // out-of-band-confirmed peer key
  | 'trusted'        // tofu / tofu-new / introduced / encrypted-unverified
  | 'decryptFailed'  // per-message untrusted (could not decrypt this message)
  | 'rejected'       // forged or absent signature
  | 'keyChanged'     // peer key rotated, encryption blocked pending acceptance
  | 'keyLocked'      // the user's own key passphrase is not entered
  | 'plaintext'      // not encrypted / unsupported / user-forced cleartext
  | 'checking'       // encryption probe in flight

export interface TrustVisual { colorClass: string; tone: TrustTone }

export function trustVisual(state: TrustVisualState): TrustVisual
```

Canonical mapping:

| State | colorClass | tone |
|---|---|---|
| `verified` | `text-fluux-encryption` (teal) | verified |
| `trusted` | `text-fluux-muted` (gray) | calm |
| `decryptFailed` | `text-fluux-yellow` (warning) | warning |
| `rejected` | `text-fluux-error` (red) | danger |
| `keyChanged` | `text-fluux-yellow` (warning) | warning |
| `keyLocked` | `text-fluux-muted` (gray) | calm |
| `plaintext` | `text-fluux-muted` (gray) | calm |
| `checking` | `text-fluux-muted` (gray) | calm |

The resolver returns color and tone only. Icons stay context-appropriate per surface (the inline per-message lock keeps the compact `Lock` family; the header and tab keep the prominent `Shield` family). This is a deliberate context distinction, not an inconsistency to flatten.

### 2. The only two visible changes

Everything else is pure tokenization (no visible change). The two semantic shifts:
- Security tab `verified`: green to teal (`text-green-600 dark:text-green-400` becomes `text-fluux-encryption`), matching the header and per-message lock.
- Chat-header `keyLocked`: yellow to gray. The user's own un-entered passphrase is UX friction, not a peer threat. This is the one genuine "alarming a non-threat" fix.

### 3. Scope

- Lock surfaces (`MessageBubble`, `ChatHeader` encryption icon, `SecurityTab`): each maps its raw state to a `TrustVisualState` and reads the color from `trustVisual`. The bare palette classes (`text-yellow-500`, `text-green-600 dark:...`, `text-red-500`, `text-yellow-600 dark:...`) are removed in favor of the resolver's tokens.
- Banners and key dialogs (KeyChangeBanner, OwnKeyConflictBanner, TrustStateCompromisedBanner, DeleteOpenpgpKeyDialog, IdentityChoiceDialog, BackupPassphraseDialog, RestorePassphraseDialog, VerifyPeerDialog, UnlockEncryptionDialog): no semantic change. Tokenize the bare `yellow/red/green` onto the existing tokens, respecting the text-versus-fill split documented in the encryption-settings work: red text uses `text-fluux-error`, red fills use `bg-fluux-red`; yellow and green have no split (`text-fluux-yellow`, `text-fluux-green`).

### 4. Preserve (must not change)

- The per-message `untrusted` yellow lock stays yellow: it is a real decrypt-failure signal, not a routine state.
- VerifyPeerDialog's SAS code-match green (`Check`) stays green: that is input-validation success, not a trust state, so it does not move to teal.
- All icons are unchanged (context-appropriate).
- All genuinely-alarming states stay alarming: `blocked`/`keyChanged` yellow, `rejected` red, compromise red, destructive-action buttons red, key-change and own-key-conflict banners yellow/red.
- No SDK change. No trust-model change. No change to `resolveDisplayTrust` semantics.

## Out of scope

- Distinguishing a routine new-but-unpinned key from a changed-from-known key at the per-message level (would need an SDK signal; the per-message lock already renders calm gray for the routine decrypt-and-verify case).
- The generic `ConfirmDialog` danger/warning button colors (not E2EE trust; conventional and already assessed intentional in the theme audit's Batch D).
- Any icon redesign.

## Theme-robustness

All colors are existing Aurora tokens that are already AA-guarded across the 13 built-in themes by `themeContrast.test.ts` (status success/warning/error as card text, text-error on the chat surface, white-on-accent) and the other contrast guards. This pass introduces no new color value, only routes existing surfaces to existing tokens, so there is no new contrast risk. `--fluux-text-encryption` already has light and dark values tuned for AA.

## Testing

- `trustVisual.test.ts`: assert the canonical mapping, with explicit cases for the two changes (`trustVisual('verified').colorClass === 'text-fluux-encryption'` and `trustVisual('keyLocked').colorClass === 'text-fluux-muted'`), plus `trusted` gray, `decryptFailed` / `keyChanged` warning, and `rejected` danger.
- A static guard that the three lock surfaces (`MessageBubble.tsx`, `ChatHeader.tsx`, `SecurityTab.tsx`) no longer contain bare trust palette classes (`text-yellow-500`, `text-green-600`, `text-red-500`, `text-yellow-600`, `text-green-400`, `text-red-600`).
- Existing component tests stay green; update any snapshot or assertion that pinned the old Security-tab green or the old keyLocked yellow.
- Screenshots are best-effort only: trust states are hard to drive in the demo harness, so the unit guard carries the proof.
