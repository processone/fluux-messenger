# Aurora Occupant Panel — Design Spec

- Status: Approved (design), pending spec review
- Date: 2026-06-27
- Screen: #4 in `2026-06-26-aurora-screen-inventory.md` (the one P2 chrome screen still pre-Aurora)
- Scope: `apps/fluux` — `OccupantPanel` (the MUC members panel) + its full-screen mobile variant

## Goal

Bring the room members panel up to the Aurora identity established across the message list, composer, and chrome: a person reads as the **same identity** (hue, avatar, presence) in the members panel as in their messages, section structure is legible at a glance, and the panel keeps its current per-row render-perf guarantees.

## Background — what's wrong today

`OccupantPanel` is competent but pre-Aurora (`OccupantPanel.tsx`, recon confirmed):

- **Occupant names are plain** `text-fluux-text`. The message list already colors senders via `auroraSenderColor` (`conversation/roomSenderResolution.ts`), so the same person is a colored name in the timeline and a flat gray name in the members panel — an identity disconnect.
- **The presence dot is flat** — a bare colored circle with a 1px border (`Avatar.tsx`), no ring/badge treatment.
- **Role section headers** are generic uppercase `text-xs font-semibold text-fluux-muted` — no hairline, no small-caps rhythm, count not emphasized.
- **The affiliation badge** uses an off-brand amber crown (`text-amber-600 dark:text-amber-400`).
- **Avatars** fall back to the legacy XEP-0392 consistent-color (`generateConsistentColorHexSync`, saturation 60 / lightness 45), unrelated to the curated Aurora sender palette.

## Design

Each item lists the **intent**, the **existing token/helper to reuse** (no new color math invented), and the **binding constraint**.

### 1. Names in identity color (headline)

- **Intent:** an occupant's name uses the same per-person hue as their messages, so identity is consistent across surfaces. Self uses `--fluux-text-self` (the own-message name color).
- **Reuse:** the exact resolution the message list uses — `auroraSenderColor(identifier, isDarkMode)` via the `roomSenderResolution` path. The `identifier` MUST be the same key the message list resolves a sender by (so the colors are byte-identical for the same person — verify against `roomSenderResolution` during implementation; it is the occupant's stable identity key, e.g. bare JID / occupant-id / nick in the same precedence the timeline uses).
- **Constraint:** the name color is already AA-tuned per theme and surface (the cross-theme contrast batch made `auroraSenderColor` surface-aware). Do not re-tune it. Resolve it **ref-stably per row** (see §7) so the row memo still bails.

### 2. Avatars in the matching hue

- **Intent:** the fallback letter avatar shares the person's identity color, so avatar and name read as one identity. Real avatars (XEP-0398 / roster photo) are untouched.
- **Treatment (concrete, reuse two existing helpers):** the fallback avatar **fill** is the person's identity color — the *same* value as the name (`auroraSenderColor`, theme- and surface-tuned) — and the fallback **letter** is that color's best-contrast black-or-white via `contrastColorForHsl` (the best-of-b/w helper from the cross-theme contrast batch). Avatar and name therefore share one hue; the letter is guaranteed legible because `contrastColorForHsl` picks whichever of black/white wins. The hue source changes from `generateConsistentColorHexSync` to this pair; no new color math is introduced.
- **Constraint (the one new contrast risk):** the fallback letter must clear WCAG AA on the avatar fill in **every theme and mode**. `contrastColorForHsl` is designed for exactly this, but it is guarded explicitly (see §8) since a mid-tone fill is the worst case. Self avatar keeps its accent fill (`--fluux-bg-accent`).

### 3. Ringed presence dots

- **Intent:** presence reads as a deliberate badge, not a dot bleeding into the avatar.
- **Treatment:** extract the presence indicator into a small shared **presence-dot** primitive: the colored dot + a 2px ring in the surface color + a faint same-color halo (`box-shadow: 0 0 0 1px <color>/35%`). Same `show` → color mapping as today (`getShowColor` / `getPresenceFromShow`: online green, away/xa amber, dnd red, offline gray). No mapping or semantic change.
- **Constraint:** the ring color is the panel surface (so the dot separates cleanly on the occupant panel today, and the primitive is reusable elsewhere). Keep the existing `--fluux-presence-*` CSS-var hook in `Avatar.tsx`.

### 4. Small-caps section labels on hairlines

- **Intent:** Moderators / Participants / Visitors / Offline / Ignored sections are scannable structural dividers.
- **Treatment:** each section header gets a hairline top-rule (`--fluux-surface-divider`, the theme-safe white/black-alpha line from the surface-delimitation slice), looser letter-spacing, the display-font feel, and the count rendered in the accent. Labels stay the existing i18n keys (`rooms.moderators` / `rooms.participants` / `rooms.visitors` / `rooms.offlineMembers` / `rooms.ignoredUsers`) — no copy changes.
- **Constraint:** reuse `occupantGrouping.ts` unchanged (it already emits the role groups + counts); this is presentation only.

### 5. Refined role tag

- **Intent:** affiliation reads as a calm tag, on-brand.
- **Treatment:** owner / admin render as a small uppercase tag (tuned gold for owner, accent for admin) replacing the off-brand amber crown; member stays a quiet marker. XEP-0317 hats are kept as-is. Tag text clears AA on its tint (reuse the existing tinted-pill pattern from elsewhere in Aurora).
- **Constraint:** no change to which affiliations are shown or their precedence; visual only.

### 6. Row + panel polish

- Active/hover row uses accent-soft (matching the sidebar's active treatment) instead of the muted `hover:bg-fluux-hover/50`.
- The self row gets a subtle accent tint so "you" is locatable.
- The bare-JID secondary line and multi-connection ("×2") badge stay, lightly aligned to the new type rhythm.

## Render-perf — preserve exactly (non-negotiable)

The redesign is presentation-only and MUST keep the existing guarantees (recon-confirmed in `OccupantPanel.tsx`):

- The `OccupantRow` memo + `occupantRowPropsEqual` (occupant **object-ref** identity) — only a flapped occupant's row re-renders.
- `useContactIdentities()` for `contactsByJid` (focused selector, not the full roster) — roster presence churn does not re-render rows.
- `useMemo` on `groupedOccupants` (recompute only when the `room.occupants` Map ref changes).
- Virtualization (`@tanstack/react-virtual`).

Implication: the new name color and avatar hue must be derived **ref-stably per row** (compute inside the memoized row from the occupant's stable identity + a mode flag), never threaded as a fresh prop from the parent on every render — the same discipline the message rows use.

## Theme-robustness + guard

- The name color (`auroraSenderColor`) is already AA across all 13 themes × 2 modes (the cross-theme contrast batch); not re-tuned here.
- The **one new contrast surface** is the fallback avatar letter on the hue fill. Add a cross-theme guard (mirroring `themeContrast.test.ts` / `glass.test.ts`): for a representative spread of identity hues, assert the fallback letter clears WCAG AA on the avatar fill in every theme and mode. If a hue/letter pairing fails, the avatar-fill tone or letter-contrast choice is adjusted until the guard passes — the same readability-first discipline as every prior Aurora slice.

## Out of scope

- **`MemberList`** (the separate roster-based 1:1 component with a standing "should show MUC participants" TODO) — not redesigned here. The new presence-dot primitive is built reusable so `MemberList` can adopt it in a later pass.
- The occupant **context menu / `UserInfoPopover`** internals — unchanged (the popover is already an Aurora surface).
- No new affiliation/role/presence semantics, no SDK changes.

## Testing

- A cross-theme avatar-letter contrast guard (§8 above), all 13 themes × 2 modes.
- A render-perf assertion that the `OccupantRow` memo still bails when an unrelated occupant's reference is unchanged (extend / mirror the existing occupant-row memo test if present).
- Screenshot scenes: the occupant panel in Aurora dark + light and 1–2 accent themes (e.g. gruvbox, dracula) to confirm the hues + ringed dots + hairline labels render and tint per theme.
- Existing `OccupantPanel` behavior tests stay green (grouping, ignored section, multi-connection).
