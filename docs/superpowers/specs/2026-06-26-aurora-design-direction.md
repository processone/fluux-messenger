# Aurora — Fluux signature design direction

- Status: Draft for review
- Date: 2026-06-26
- Scope: App-wide visual identity for `apps/fluux` (the reference client). SDK is unaffected.
- Decision on file: "Signature & crafted" direction chosen; **Aurora** selected over Atelier (warm editorial) and Vivid (consumer bubbles).

## 1. Goal / north star

Make Fluux a *signature, crafted* messaging client — beautiful in its own right rather than a well-built lookalike — **without** discarding the mature foundation already in place: the 3-tier token system, 14 themes, the accent picker, font-size slider, WCAG-AA care, i18n/RTL, and the render-performance architecture.

Aurora is a **Foundation-tier reskin plus a set of structural component upgrades**, not a teardown. It becomes the new default identity (the `:root` / `.light` values); every existing theme keeps overriding on top of it unchanged.

## 2. Why (audit recap)

From the design audit of the current build:

1. **Derivative identity** — the default neutral ramp is Discord's (`#1e1f22 / #2b2d31 / #313338`) and the accent is Discord blurple (`#5865f2`). No recognizable Fluux signature.
2. **Two message languages** — the 1:1 view is spacious (avatar + name on nearly every message); rooms are compact/grouped. They read as two apps. No shared grammar.
3. **No depth language** — surfaces differ by one grey step; a single shadow token; everything on one plane.
4. **Loose 1:1 rhythm** — avatar-per-message, large gaps, an alarm-red "New messages" divider.
5. **Unresolved composer** — heavy full-width grey bar, especially in light; attach/emoji/send not a considered cluster.
6. **Flat typography** — Inter at default weights, no real scale, inconsistent section headers.
7. **Wasted space** — contact profile and side panels leave large voids; empty states are placeholders.

## 3. Design language

### 3.1 Color — Foundation, dark (replaces `:root` `--fluux-base-*`)

Deep ink-navy ramp (monotonic dark → light), mapped onto the existing slot names so the Semantic + Component tiers inherit automatically:

| Token | Aurora dark | Used by (via semantic tier) |
|-------|-------------|------------------------------|
| `--fluux-base-00` | `#090D18` | deepest / app behind chrome |
| `--fluux-base-05` | `#0A0F1E` | bg-secondary, dividers |
| `--fluux-base-10` | `#0B1020` | bg-primary → icon rail |
| `--fluux-base-20` | `#0E1326` | bg-tertiary → sidebar / conversation list |
| `--fluux-base-30` | `#0F1528` | chat-bg |
| `--fluux-base-40` | `#141B30` | bg-hover → elevated / composer |
| `--fluux-base-50` | `#1A2238` | bg-active → overlay / modal |
| `--fluux-base-60` | `#2A3553` | strong borders |
| `--fluux-base-70` | `#5E6B8A` | text-faint |
| `--fluux-base-80` | `#97A4C4` | text-muted |
| `--fluux-base-90` | `#E9EDF7` | text-normal |
| `--fluux-base-100` | `#F4F6FC` | highest-contrast text |

Hairline border `rgba(255,255,255,0.07)`; strong border `--fluux-base-60`.

### 3.2 Color — Foundation, light (replaces `.light` `--fluux-base-*`)

Cool-warm off-white (not flat white), preserving the current "chrome is grey, chat is pure white" intent:

| Token | Aurora light | Used by |
|-------|--------------|---------|
| `--fluux-base-00` | `#FFFFFF` | — |
| `--fluux-base-05` | `#F4F6FC` | bg-secondary |
| `--fluux-base-10` | `#EDEFF7` | icon rail |
| `--fluux-base-20` | `#F1F3FA` | sidebar / list |
| `--fluux-base-30` | `#FFFFFF` | chat-bg |
| `--fluux-base-40` | `#E9ECF6` | hover |
| `--fluux-base-50` | `#DDE2F0` | active |
| `--fluux-base-60` | `#C2C9DC` | borders |
| `--fluux-base-70` | `#8A93AD` | text-faint |
| `--fluux-base-80` | `#5C6685` | text-muted |
| `--fluux-base-90` | `#1B2233` | text-normal |
| `--fluux-base-100` | `#0E1426` | highest-contrast text |

### 3.3 Accent + luminous companions

- Accent triplet (replaces `--fluux-accent-h/s/l`): `h:231 s:100% l:71%` → resting fill ≈ `#7E8DFF` (periwinkle). Hover via existing `calc(l − 8%)`.
- `--fluux-text-self` (own-message name): dark `#A9B4FF`, light `#4F5BD8` (both AA-verified on the chat bg + hover).
- New `--fluux-accent-2` (teal companion): dark `#38E0C4`, light `#11A88C` — presence/positive/secondary highlights, the encryption shield.
- New `--fluux-grad` (signature gradient): `linear-gradient(135deg, #38E0C4, #7C8CFF, #A78BFA)` — used **sparingly**: the brand mark and the send button only.

### 3.4 Sender palette (new token group)

A curated, harmonious set replacing today's arbitrary name colors. Deterministic assignment: hash of the bare JID → index, stable per user and identical in the thread, the conversation list, and the occupant panel. This set is **mode-specific, not theme-specific** (so it survives theme switches and is AA-tuned per mode).

| # | Dark (name-on-chat) | Light (name-on-white) |
|---|---------------------|------------------------|
| 1 sky | `#9FD4FF` | `#1E84D8` |
| 2 mint | `#6FE3B0` | `#119E73` |
| 3 amber | `#FFCB73` | `#B5790E` |
| 4 rose | `#FF9DB0` | `#D8527A` |
| 5 lilac | `#C2ABFF` | `#6E54D8` |
| 6 teal | `#67D4D0` | `#128C86` |

Avatars use a 135° gradient between two adjacent hues from this set.

### 3.5 Elevation

Five surface levels + hairline + one functional overlay shadow + a glass recipe.

- L0 page/rail (`base-10`), L1 list (`base-20`), L2 chat (`base-30`), L3 elevated/hover/composer (`base-40`), L4 overlay/modal/popover (`base-50`).
- Hairline divider as above; `--fluux-shadow-overlay`: dark `0 24px 70px rgba(0,0,0,0.55)`, light `0 20px 50px rgba(20,27,48,0.18)`. (This is the one place a drop shadow is used; everything else relies on surface step + hairline.)
- Glass (transient surfaces only — command palette, popovers): `--fluux-glass-bg` (translucent L4, ~0.74 alpha) + `backdrop-filter: blur(12px)` + a 1px top white-highlight + hairline. Gated behind `@supports (backdrop-filter)`, with the solid L4 as fallback.

### 3.6 Typography

- Add **Inter Tight** (self-hosted `.woff2`, weights 500/600) as `--fluux-font-display`. Inter stays the body face.
- Scale (semantic, not raw px scattered in components):
  - display-lg 22/600 — view titles ("Messages")
  - display 18/600 — modal titles, large section headers
  - title 15/600 — chat/room header name
  - name 14/600 — sender name
  - body 14/400, line-height 1.5 — messages
  - meta 12/400 — timestamps, presence, captions
  - micro 11/400 — group/section labels, rendered small-caps via `font-variant: all-small-caps` (never an uppercase transform — keeps i18n/RTL correct)
- Font-size slider continues to scale the whole scale.

### 3.7 Motion

Reuse existing keyframes (typing dots, reaction-burst, FAB spring, message-send, message-highlight, sidebar-view-enter). Add:
- `modal-in` (scale 0.96 → 1 + fade, 150ms) and a backdrop fade.
- Optional shared-element transition on conversation open where cheap.
- Everything gated on `prefers-reduced-motion: reduce`.

## 4. Component specs

### 4.0 App shell (persistent layout)
The window keeps a fixed four-region shell. Aurora restyles each region but **does not change the structure** — no region is removed.

1. **Icon rail** (~52px) — switches views (Messages / Rooms / Contacts / Notifications / Search) + account. Always visible.
2. **Conversation / room list** (~220–280px) — *the left sidebar*. Lists conversations or rooms for the active view. **Always visible on desktop; not removable.**
3. **Conversation** — header + message thread + composer.
4. **Contextual panel** (~200–300px) — occupant/members list in rooms, profile in contacts. The **only** collapsible region: an in-flow column at `lg+`, a slide-in drawer below `lg` (existing `animate-drawer-in`).

Note: the inline room mockup shown during brainstorming compressed away region 2 to fit the 680px preview width. It is retained in the real layout — rooms are rail + room list + conversation + occupant panel.

### 4.1 Icon rail
Brand mark on top (gradient rounded square, 30px — placeholder until a real logomark exists), nav icons 19px, active = accent-soft pill + `--fluux-text-self`-bright icon; settings + account avatar pinned to the bottom. Width 52–56.

### 4.2 Conversation list (sidebar)
Header uses display-lg; search is an inset L0 pill. Items: 34px avatar (sender-hue gradient), name 13/600, preview 12 muted (truncated), time 11 faint, **unread badge in accent (not red)**. Active item = accent-soft fill + 2px inset accent edge. Honors the density setting (§6). Keep the id-list-subscription + per-row self-subscription pattern from the render-perf work — no new store-wide subscriptions here.

### 4.3 Message grammar (unified across 1:1 and rooms)
This is the structural fix for audit issue #2.
- **Grouping**: consecutive messages from the same sender within 5 minutes form a run. The first row shows avatar + name + time; subsequent rows align in the same gutter with no repeated avatar/name (time appears on hover).
- **Own messages**: a luminous left-edge (2px accent + faint accent tint), name in `--fluux-text-self`. Not a bubble (Vivid's bubble grammar was explicitly rejected).
- **Sender name color**: from the sender palette, deterministic. 1:1 uses two slots (peer + self).
- **Reactions**: L3 pill + hairline, icon in accent, `+N` overflow.
- **Reply quote**: snippet with accent left-rule + author; click scrolls + existing highlight animation.
- **Mentions**: accent chip (accent-soft bg + bright accent text).
- **Whisper** (XEP-0045 private): reserved violet (`--fluux-private*`) left-edge block + "Private with X" label — deliberately distinct from accent and from the encryption palette.
- **Encryption**: per-message teal shield in the meta line; existing trust-state banners restyled to Aurora, logic untouched.
- **Dividers**: new-messages = hairline + accent label (replaces alarm-red); date = hairline + faint label.
- **Attachments / link previews**: L3 card, radius-l, hairline; images get rounded corners + a subtle frame (fixes the current heavy black image frame).

### 4.4 Composer
Contained card (L3), inset from edges, radius 14, hairline that becomes an accent focus-edge on focus. Left: attach (`+`). Right: emoji + gradient send. Autosizes (existing logic). Reply/whisper context docks as a chip inside the card, above the input. Density-aware min-height. This is the most-used surface and gets the most polish.

### 4.5 Occupant / members panel
Group labels (Moderators / Participants / …) as small-caps on hairlines (reuse `occupantGrouping.ts`). Rows: 28px avatar (sender hue) + ringed presence dot (green/amber/red) + name in identity color + role tag. Keep `roomSenderResolution.ts` so only the flapped occupant's rows re-render on presence churn.

### 4.6 Modals & overlays
- Overlay: backdrop fade (deep + 0.5 alpha) + centered L4 surface, hairline, `--fluux-shadow-overlay`, radius-xl. Header = display title + optional subtitle + close X. Body padding 18, gap 13. Footer = hairline top, right-aligned, secondary + primary (accent gradient); danger variant `#E5484D`.
- Form fields: 12px muted label, 40px L1 input + hairline, focus = accent border + 3px accent ring. Segmented control (L1 + accent-soft active). Switch (accent gradient).
- **Command palette**: glass surface, luminous search row, grouped results (small-caps headers), active row = accent-soft + inset accent edge, keyboard-hint footer. The signature transient surface.
- Confirm/destructive: narrow (~380px), concise title + body + Cancel/danger.
- Toasts, tooltips, popovers: L4 + hairline (toasts already animate via `toast-in`).
- Centralize via `ModalShell.tsx` / `ModalHost` so the language is defined once.

### 4.7 Empty states
Restrained and centered: a faint line/gradient mark + one-line prompt + a primary action. Replace dead-space panels (e.g., the contact-profile right void) with a meaningful empty state, or collapse the panel until a contact is selected.

## 5. Implementation — token mapping

Primary edits are confined to the token layer; components consume tokens.

- `apps/fluux/src/index.css`
  - `:root` (dark): replace `--fluux-base-*` per §3.1; set `--fluux-accent-h/s/l` per §3.3; add `--fluux-accent-2`, `--fluux-grad`, `--fluux-font-display`, `--fluux-glass-bg`, `--fluux-shadow-overlay`, `--fluux-sender-1..6`. Add Inter Tight `@font-face`.
  - `.light`: same overrides per §3.2 / §3.3 light values.
  - Change `--fluux-badge-bg` (unread) from `status-error` to accent.
  - Add the `modal-in` keyframe + glass `@supports` guard.
- `tailwind.config.js`: add `fontFamily.display`, `colors.fluux.accent-2`, `colors.fluux.sender-1..6`, `colors.fluux.glass`.
- Component touch-ups (small): rail/list/composer/occupant classes for elevation + density; the new-messages divider color; message-row grouping + own-edge + sender-hue.
- The 14 themes stay as-is; they override Foundation/accent. The sender palette is provided per-mode (dark/light), independent of theme, so it never clashes with a theme's accent.

## 6. Density
Add a "comfortable | compact" setting in Appearance (default comfortable). Comfortable = the rhythm in the mockups; compact tightens row padding and avatar size for power users in busy rooms. Drives a `data-density` attribute consumed by list/message/occupant CSS.

## 7. Phased rollout (one PR per phase)

- **P0 — Tokens + type** (regression-safe, no component change): ramp, accent, sender palette, elevation tokens, Inter Tight, glass/shadow tokens. App visibly shifts to Aurora colors; layout unchanged.
- **P1 — Unified message grammar**: shared grouping + own-edge + sender-hue across `ChatView.tsx` and `RoomView.tsx` rows. Reuse `roomSenderResolution.ts` / `occupantGrouping.ts`; add render-count guards (the message-row memo guards already exist — extend them).
- **P2 — Chrome**: icon rail, conversation list, occupant panel, composer card.
- **P3 — Overlays**: `ModalShell`/`ModalHost` restyle + `CommandPalette.tsx` glass + shared form-field/button components.
- **P4 — Empty states, density, motion polish** (`modal-in`, reduced-motion audit).

Each PR: `npm run typecheck` + `npm test` clean (no stderr), render-count guards green, then `npm run screenshots` to refresh `screenshots/` + `OVERVIEW.md`.

## 8. Constraints / non-goals

- Preserve all 14 themes, accent picker, font-size slider, i18n/RTL.
- Respect render-perf: no new store-wide subscriptions in list/message rows; per-key subscriptions; keep existing memo guards.
- No new heavy dependencies. Inter Tight self-hosted (no Google Fonts at runtime, matching the existing privacy stance). Icons stay on the current set.
- **Bubbles are out of scope** — the flat, grouped grammar is the chosen direction.
- Maintain WCAG AA for all text including the sender palette (values above are tuned per mode); keep focus rings; honor reduced motion.

## 9. Open questions

1. Density default — confirm comfortable-by-default + compact toggle.
2. Light `base-10/20` cool-grey — verify it doesn't read too blue once built; tune after P0.
3. Brand mark — is there a real Fluux logomark to replace the gradient placeholder in the rail?

## 10. References

- In-conversation mockups (presented during brainstorming): three signature directions; Aurora applied (dark) sidebar + 1:1; Aurora busy room (dark) + Aurora light; Aurora modal language (command palette, create-room, confirm).
- Current state: `screenshots/OVERVIEW.md`; token tiers in `apps/fluux/src/index.css`; `apps/fluux/tailwind.config.js`.
- Relevant components: `ChatView.tsx`, `RoomView.tsx`, `MessageComposer.tsx`, `Sidebar.tsx`, `OccupantPanel.tsx`, `ModalShell.tsx`, `CommandPalette.tsx`, and the render-perf utilities `roomSenderResolution.ts` / `occupantGrouping.ts`.
