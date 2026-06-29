# Aurora Auth / Login — Design Spec

- Status: Approved (design + brand-mark choice), pending spec review
- Date: 2026-06-28
- Screen: #8 in `2026-06-26-aurora-screen-inventory.md` ("Auth surfaces — LoginScreen / LoginErrorPanel") — the LAST roadmap screen
- Scope: `apps/fluux` — `LoginScreen` branding pass (+ a light `LoginErrorPanel` touch). Effort S.

## Goal

The login is the first screen a new user sees, and today it is plain: the Aurora gradient and display font are defined but unused, the heading is a generic `text-2xl`, and the logo is a flat 64px image. Give it a branded Aurora first impression — a luminous gradient mark, display typography, an elevated card, and a faint aurora backdrop — without touching the auth flow.

## Background — current state (recon-confirmed)

`LoginScreen.tsx` is functional + already token-based (no hardcoded colors): full-height `bg-fluux-bg` container, centered `max-w-md` card on `bg-fluux-sidebar rounded-lg p-6`, a `/logo.png` (`size-16`) + `h1 text-2xl font-bold` + muted subtitle, JID/password/server fields (JID + server use `ui/TextInput`), a remember-me checkbox, and a `bg-fluux-brand` Connect button with a connecting spinner. `LoginErrorPanel.tsx` is already Aurora-appropriate (tokenized `bg-fluux-red/20` + `text-fluux-error`, `ShieldAlert`/`AlertTriangle` icons, calm). The login renders INSIDE an already-themed `<html>` (ThemeProvider runs in `main.tsx` before routes), so it inherits the active theme. **Unused on login:** `--fluux-grad`, an intentional `--fluux-font-display` heading, `--fluux-shadow-overlay`, `--fluux-surface-divider`.

## Design

### 1. Gradient app-tile brand mark (the brand moment)

Replace the flat `<img src="/logo.png">` with a bold Aurora mark: a ~64px rounded-square tile filled with `--fluux-grad` (the signature teal -> periwinkle -> violet), a clean white lucide glyph centered on it (a message glyph, e.g. `MessageCircle` / `MessagesSquare` — the implementer picks the cleanest), and a soft gradient glow behind it (a blurred, lower-opacity `--fluux-grad` layer) so it reads as luminous. Centered above the heading. The white glyph on the mid-tone gradient is decorative (non-text, the 3:1 floor); confirm it stays legible.

### 2. Display-font heading

"Fluux Messenger" (the existing `login.title` key) set intentionally in the display font (`font-display`), larger (`text-3xl`), `tracking-tight`, `text-fluux-text`. Subtitle (`login.subtitle`) stays `text-fluux-muted`. Copy unchanged.

### 3. Elevated card

The form card keeps `bg-fluux-sidebar` but gains a hairline border (`--fluux-surface-divider`) + the overlay shadow (`--fluux-shadow-overlay`) so it reads as a clean elevated panel (deep-ink in dark, cool-white in light). Radius/padding unchanged.

### 4. Faint aurora backdrop

A subtle, low-opacity radial `--fluux-grad` glow on the full-screen `bg-fluux-bg` container (behind/above the card) for atmosphere — decorative, very faint, must NOT reduce text or field contrast. Sits behind the card; the Tauri drag region + scroll behavior are preserved.

### 5. Error panel — light touch only

`LoginErrorPanel` is already tokenized + iconed + calm. Keep it; at most align its box radius/spacing to the card. No restructure, no new states.

## Preserve (existing functionality the redesign MUST keep)

- **Advanced-mode toggle (the top-right kebab).** `LoginScreen.tsx:427-438` renders a quiet `OverflowMenu` (`absolute top-0 end-0 z-10`) with the single item `login.advancedMode` (Wrench icon, `active={advancedMode}`, toggling `useAdvancedModeStore`). Toggling it reveals the custom-server field (`{(showServerField || advancedMode) && ...}`, line ~535) and unlocks the app's expert surfaces (XMPP console, Advanced settings). The redesign KEEPS this kebab and its behavior unchanged. Watch the layering: it must stay clickable and visible above the new aurora backdrop glow (`z-10` over the decorative glow) and not be overlapped by the centered gradient mark (the mark is centered, the kebab is the top-right corner — no overlap, but verify after adding the backdrop). The mock omitted it for simplicity; it stays.
- **The custom-server field** (revealed by advanced mode / auto-reveal) keeps its `ui/TextInput` + the calm link-server note, restyled only to match the card (consistent field treatment), no behavior change.
- **Remember-me, prefill/deep-link, keychain/FAST persistence, auto-connect** — all unchanged.
- **Footer copy is unchanged** — keep the existing two lines: "Made by [ProcessOne], the company behind [ejabberd]" and "**Powered by [XMPP]**" (the second line already links `XMPP` to `xmpp.org` — NOT ejabberd). Restyle only (it already uses `text-fluux-brand` links). The mock incorrectly showed "Powered by ejabberd"; the real/kept copy is "Powered by XMPP".

## Theme-robustness

- The **gradient mark uses `--fluux-grad`** — the Fluux brand signature, which IS overridden for light vs dark (`#38E0C4,#7C8CFF,#A78BFA` dark / `#11A88C,#5B6CF0,#7C6CF0` light). No theme overrides `--fluux-grad`, so on non-Aurora themes the mark stays the Aurora gradient — intentional, since it is the PRODUCT brand mark (not theme chrome).
- The **surfaces inherit the active theme** (`bg-fluux-bg`, `bg-fluux-sidebar`), so the login tones to the user's theme.
- **Text contrast:** the heading (`text-fluux-text`) + subtitle (`text-fluux-muted`) render on `bg-fluux-sidebar` / `bg-fluux-bg`; `text-muted` on the sidebar surface is already AA-guarded by `emptyStateContrast.test.ts` (the settings/empty-states fix). The Connect button is `bg-fluux-brand` + `text-fluux-text-on-accent` (the white-on-accent AA invariant). No new contrast risk expected; confirm during implementation.

## Out of scope

- No auth/connection flow, field, validation, remember-me, prefill, or persistence changes — purely visual.
- No copy rewrites (reuse all existing `login.*` i18n keys).
- No `LoginErrorPanel` restructure. No SDK changes.

## Testing

- `LoginScreen.test.tsx` stays green (the mark/heading/card are presentational; fields + handlers unchanged). Add/extend a render check that the gradient mark + display heading render.
- Confirm the login text is AA on its surfaces across themes (reuse the existing contrast coverage; the surfaces are the already-guarded sidebar/bg).
- Screenshots: the login screen in Aurora dark + light + 1-2 accent themes (e.g. gruvbox), to confirm the gradient mark + display heading + elevated card render and the backdrop glow is subtle, with readable fields.
