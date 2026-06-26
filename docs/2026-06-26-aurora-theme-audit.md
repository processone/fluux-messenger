# Aurora Theme Audit — Contrast, Visibility & Readability

**Date:** 2026-06-26
**Scope:** Aurora theme (`id: fluux`), both **dark** and **light** modes.
**Method:** Hybrid — exact WCAG 2.1 contrast computation on every token pairing actually used in the UI, cross-checked against live computed-style measurements and rendered screenshots in demo mode.

> Most findings are structural token-placement issues that surface identically across all 13 built-in themes. Fixing them in Aurora's shared semantic tokens fixes them everywhere.

---

## 1. Executive summary

The system is fundamentally sound: fully token-driven, a clean 3-tier cascade, WCAG-aware accent-fill contrast. The problems are not the palette values themselves but **the wrong _kind_ of token applied in the wrong place**, concentrated in four structural patterns:

| # | Pattern | Severity | Where | Root cause |
|---|---------|----------|-------|-----------|
| **A** | **Elevation is invisible** — floating/raised/hover/active surfaces and panel boundaries do not read as distinct | **High** | FAB, hover/active rows, rail↔sidebar↔chat seams, inputs, modals, dividers, tooltips | `--fluux-border-color` uses **black alpha in both modes** (invisible on dark), and the neutral ramp steps 10→50 are too close in luminance to separate by fill alone |
| **B** | **"Faint" text fails AA** | **High (light) / Med (dark)** | timestamps, faint/tertiary text, links & self-name in light mode | `--fluux-text-faint` and several light-mode colors fall below 4.5:1 |
| **C** | **Color-as-text fails AA, severely in light mode** | **High** | MUC sender names, status (success/warning/error) text & icons | light-mode sender + status palettes are too light; many below 3:1 |
| **D** | **Hardcoded non-token colors** | **Low–Med** | ~25 sites (red-500/green-500/yellow-500/amber, white/10, black/50, ad-hoc shadows) | bypass the theme system; break under non-Aurora themes and can't be tuned for contrast |

Plus a focus-visibility inconsistency (E) and minor observations (F).

**The FAB you flagged is the poster child of Pattern A** — it is `bg-fluux-bg` (identical to the chat background, **1.04:1**) with a border of `rgba(0,0,0,0.1)` (**1.01:1** — mathematically invisible on dark). Its only separation from the canvas is a soft shadow that barely reads on deep ink.

---

## 2. Methodology

1. **Token resolution** — every semantic/component token resolved to concrete sRGB for both modes from [index.css](apps/fluux/src/index.css) (`:root` = dark, `.light` = light).
2. **Usage inventory** — every visible foreground↔background pairing in the UI traced to `file:line` (chat, sidebar, rail, composer, modals, toasts, tooltips, settings, occupant panel, search).
3. **Contrast computation** — WCAG 2.1 relative-luminance ratios, with alpha tokens composited over their actual backdrop. (Script archived; numbers below are exact, not estimated.)
4. **Live cross-check** — `getComputedStyle` measurements in the running demo confirmed the math (e.g. muted preview text measured **5.00:1**, predicted 5.00:1).
5. **Visual confirmation** — Aurora dark + light rendered in demo mode.

### Severity model

- **High** — fails WCAG AA (4.5:1) for informational text, OR an interactive control / essential boundary is effectively invisible (< ~1.5:1 separation).
- **Medium** — AA-large only (3:1) where AA is wanted, borderline (dips below AA in some states), or a hierarchy layer that does not read as distinct.
- **Low** — polish: semantic-color inconsistency, hardcoded colors, minor legibility.

---

## 3. Findings

### Pattern A — Invisible elevation & boundaries  `High`  `Control visibility / Surface hierarchy`

**Control/surface separation ratios (need ~3:1 to read as a distinct shape; < 1.5 = invisible):**

| Pairing | Dark | Light |
|---|---|---|
| **FAB** (`bg-fluux-bg`) on chat-bg | **1.04** | **1.20** |
| hover row (`base-40`) on chat-bg | 1.06 | 1.23 |
| active row (`base-50`) on chat-bg | 1.15 | 1.30 |
| sidebar (`base-20`) ↔ chat (`base-30`) | **1.02** | 1.14 |
| rail (`base-10`) ↔ sidebar (`base-20`) | 1.02 | 1.06 |
| input (`base-10`) on chat-bg | 1.04 | 1.20 |
| modal (`base-20`) on primary (`base-10`) | 1.03 | 1.06 |
| **border** `rgba(0,0,0,α)` on any dark surface | **1.01–1.03** | 1.41 |

**Two compounding causes:**

1. **`--fluux-border-color` is black-alpha in both modes** ([index.css:205](apps/fluux/src/index.css:205) `rgba(0,0,0,0.1)`; [:381](apps/fluux/src/index.css:381) `rgba(0,0,0,0.15)`). A *dark* border on a *dark* surface is invisible (1.01–1.03:1). Borders carry the entire burden of defining edges for the FAB, inputs, modals, tooltips, dividers, attach menu, search box — and in dark mode they contribute nothing. Confirmed in the dark render: the icon rail and sidebar merge into one mass.
2. **The neutral ramp is compressed at the dark end** — `base-30→40→50` (`#0F1528 / #141B30 / #1A2238`) differ by ~0.1 in ratio, so hover/active/elevation cannot be conveyed by fill lightness alone.

**Affected sites (representative):**
- Scroll-to-bottom FAB — [MessageList.tsx:522](apps/fluux/src/components/conversation/MessageList.tsx:522) (`bg-fluux-bg border border-fluux-border`)
- Composer container & inputs — [MessageComposer.tsx:648](apps/fluux/src/components/MessageComposer.tsx:648), search input — [SearchView.tsx:128](apps/fluux/src/components/sidebar-components/SearchView.tsx:128)
- Modals — [ModalShell.tsx:45](apps/fluux/src/components/ModalShell.tsx:45), tooltips — [Tooltip.tsx:254](apps/fluux/src/components/Tooltip.tsx:254), toasts — [ToastContainer.tsx:35](apps/fluux/src/components/ToastContainer.tsx:35)
- Panel seams: rail↔sidebar↔chat have no hairline; they rely on near-zero luminance steps.

**Proposed fix (batch A):**
- **Split `--fluux-border-color` by mode polarity**: light-alpha on dark (`rgba(255,255,255,0.10–0.14)`), black-alpha on light (bump light to ~`0.18`). This single change restores edges to every bordered control/panel in dark mode.
- Add an explicit **elevated-surface token** (e.g. `--fluux-bg-float`) for floating controls (FAB, menus, tooltips), lighter than its backdrop, paired with the now-visible border + existing shadow. FAB should use it instead of `bg-fluux-bg`.
- Give the **rail / sidebar / chat seams a hairline** using the corrected border token (fill contrast alone can't reach 3:1 at the dark end, and shouldn't need to).

---

### Pattern B — "Faint" text below AA  `High (light) / Med (dark)`  `Text contrast`

**Text-on-surface ratios (AA = 4.5; `!` below AA, `!!` below 3.0):**

| Token | Dark (chat-bg) | Light (chat-bg) | Light (on hover/active) |
|---|---|---|---|
| `text-normal` | 15.5 | 15.9 | 12.3–13.0 |
| `text-muted` | 7.3 | 5.7 | 4.4–4.6 `!` |
| **`text-faint` / timestamps** | **3.41 `!`** | **3.78 `!`** | **2.92 `!!`** |
| `text-self` (own name) | 9.2 | 5.5 | **4.24–4.49 `!`** |
| `text-link` | 6.9 | 5.2 | **4.01–4.24 `!`** |

- **Timestamps fail AA in both modes** — `--fluux-text-faint` ([index.css:182](apps/fluux/src/index.css:182)) is used for message timestamps ([MessageBubble.tsx:552](apps/fluux/src/components/conversation/MessageBubble.tsx:552)) and several markers; ~3.4:1. They carry information (when a message was sent) so AA applies.
- In **light mode**, `text-muted`, `text-self`, and `text-link` all dip **below 4.5:1 on hover/active surfaces** (`base-40/50`). Links at 4.01–4.24 are the most-used offender.

**Proposed fix (batch B):**
- Darken/lighten `--fluux-text-faint` to clear 4.5:1 on its real surfaces (target ~`#7E8BA8` dark / ~`#646F8C` light), OR if "faint" is intentionally decorative, reserve it for non-informational glyphs and move **timestamps to `text-muted`**.
- Nudge light-mode `text-link` and `text-self` ~6–8% darker so they hold AA on `base-40/50`.

---

### Pattern C — Color-as-text fails AA, severe in light mode  `High`  `Color semantics / Text contrast`

**Light mode is the problem; dark mode mostly passes.**

| Token (as text) | Dark (chat-bg) | Light (chat-bg) | Light (sidebar base-20) |
|---|---|---|---|
| sender-1 | 11.5 | 3.93 `!` | 3.45 `!` |
| **sender-2** | 11.5 | **3.41 `!`** | **2.99 `!!`** |
| **sender-3** | 12.1 | 3.68 `!` | **3.23 `!`** |
| **sender-4** | 9.2 | 3.88 `!` | 3.41 `!` |
| sender-5 | 9.1 | 5.35 | 4.70 |
| sender-6 | 10.3 | 4.10 `!` | 3.60 `!` |
| status-success (text/icon) | 5.7 | **3.18 `!`** | **2.80 `!!`** |
| **status-warning** (text/icon) | 9.6 | **1.89 `!!`** | **1.66 `!!`** |
| status-error (text/icon) | 4.0 `!` | 4.57 | 4.02 `!` |

- **MUC sender names are unreadable for several colors in light mode** — 5 of 6 sender tokens fall below AA on the white chat surface; sender-2/3 dip below **3:1** on the sidebar. Sender names are the primary way to attribute messages in a room. ([ChatView sender assignment](apps/fluux/src/components/ChatView.tsx:811), tokens [index.css:390](apps/fluux/src/index.css:390))
- **Status colors as text/icons fail in light mode** — green status text ~2.5–3.2:1, yellow ~1.5–1.9:1 (effectively invisible). The light theme already darkens `blue`/`gray` for this reason ([index.css:363](apps/fluux/src/index.css:363)) but **not green/yellow/red**.
- **`status-error` as text dips below AA in dark** (3.97 on chat-bg) — the red used for "delivery failed", new-message marker, etc. *(Resolved — follow-up: see below.)*
- **`white` on `status-warning` fill = 1.89 (FAIL)** in both modes — safe today only because warning isn't used as a text-bearing fill; flag before any "warning button/badge" is added.

**Proposed fix (batch C):**
- **Darken the light-mode sender palette** further (the one darkening pass wasn't enough) so all six clear 4.5:1 on white *and* on `base-20`.
- **Add light-mode overrides for `status-success` / `status-warning` / `status-error`** (darker variants), mirroring what's already done for blue/gray — so status text/icons stay legible.
- Nudge `status-error` for dark-mode text use, or pair it with a non-color cue where it labels (icon + text).

**Resolved (follow-up to this audit):** A single red token cannot satisfy both jobs — as a *fill* it must stay dark enough for white text to clear AA (white on `#da373c` = 4.57), but as *text* on the dark chat surface it must be lighter to clear AA (it reached only ~3.74-3.97). So the two were split: `--fluux-status-error` keeps serving fills, and a new `--fluux-text-error` is tuned to clear AA as text on the chat surface in both modes. The `text-fluux-red` / `text-red-500` error-text consumers (delivery-failed, new-message marker, etc.) now point at `text-fluux-error`; `bg-fluux-red` fills are unchanged. Every builtin theme that overrides `--fluux-color-red` also tunes `--fluux-text-error`, and [`themeContrast.test.ts`](apps/fluux/src/themes/themeContrast.test.ts) guards the AA contract per theme. See [docs/THEMES.md](docs/THEMES.md) Tier 2 for theme-author guidance.

---

### Pattern D — Hardcoded non-token colors  `Low–Med`  `Color semantics`

~25 sites bypass the token system with raw Tailwind palette colors. They won't adapt to non-Aurora themes and can't be contrast-tuned centrally. Grouped:

**Status colors that should be `--fluux-status-*`:**
- Trust/lock icons green/red/yellow-500 — [MessageBubble.tsx:559-565](apps/fluux/src/components/conversation/MessageBubble.tsx:559)
- Composer encryption badge & edit labels green/red-500 — [MessageComposer.tsx:672](apps/fluux/src/components/MessageComposer.tsx:672), [:935](apps/fluux/src/components/MessageComposer.tsx:935)
- Delivery error red-500 — [MessageBubble.tsx:668](apps/fluux/src/components/conversation/MessageBubble.tsx:668)
- Notification permission status green/red/yellow-500 — [NotificationsSettings.tsx:156](apps/fluux/src/components/settings-components/NotificationsSettings.tsx:156)
- Confirm-dialog danger/warning `bg-red-500`/`bg-orange-500` — [ConfirmDialog.tsx:32](apps/fluux/src/components/ConfirmDialog.tsx:32)
- Occupant "owner" badge amber, "Quick Chat" header amber-500 — [OccupantPanel.tsx:54](apps/fluux/src/components/OccupantPanel.tsx:54), [RoomsList.tsx:232](apps/fluux/src/components/sidebar-components/RoomsList.tsx:232)
- App-offline presence `bg-slate-500` — [ui.ts:23](apps/fluux/src/constants/ui.ts:23)

**Surfaces/overlays that should be semantic tokens:**
- Modal/dialog backdrops `bg-black/50` (token `--fluux-modal-backdrop` exists but is unused) — [ModalShell.tsx:36](apps/fluux/src/components/ModalShell.tsx:36), [ConfirmDialog.tsx:38](apps/fluux/src/components/ConfirmDialog.tsx:38), [UserMenu.tsx:168](apps/fluux/src/components/UserMenu.tsx:168)
- Icon-rail hover `bg-white/10` — [IconRailNavLink.tsx:45](apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx:45)
- Tooltip ad-hoc shadow `shadow-[0_4px_16px_rgba(0,0,0,0.25)]` — [Tooltip.tsx:254](apps/fluux/src/components/Tooltip.tsx:254)
- Video thumb overlay `bg-black/30` — [MessageComposer.tsx:758](apps/fluux/src/components/MessageComposer.tsx:758)

**Proposed fix (batch D):** mechanical token substitution. Reuse `--fluux-modal-backdrop` (already defined). Note `bg-fluux-red` is referenced in a few places but only `--fluux-red` (alias) exists — verify the Tailwind alias resolves, since several danger buttons mix `bg-red-500` and `bg-fluux-red`.

---

### Pattern E — Focus visibility  `Medium`  `Control visibility`

- The global focus ring ([index.css:637](apps/fluux/src/index.css:637)) applies **only after** `.user-interacted` is set, and many inputs override it with `outline-none` + a border-color change only ([AppearanceSettings.tsx:150](apps/fluux/src/components/settings-components/AppearanceSettings.tsx:150)). Keyboard focus is inconsistently visible across modals, settings inputs, and buttons.
- **Proposed fix (batch E):** standardize a `focus-visible:ring-2 ring-fluux-focus-ring` utility; stop replacing the ring with border-only changes (border at 1.41:1 in light / invisible in dark is not a sufficient focus cue).

---

### Pattern F — Minor observations  `Low`

- **Glass tokens defined but unused** — `--fluux-glass-bg` / `--fluux-glass-blur` exist but no component consumes them; modals use opaque `--fluux-sidebar-bg`. Either wire glass into modals/overlays or drop the dead tokens.
- **Soft-muted via opacity** — `text-fluux-muted/60` and `/40` (search context, occupant counts) stack opacity on an already-marginal color; can drop below AA. Prefer a dedicated `--fluux-text-faint`-style token over opacity.
- **`--fluux-accent-2` / `--fluux-grad` (Aurora's signature teal + gradient) are defined but unused** in the audited surfaces — an identity opportunity, not a defect.

---

## 4. Batch-fix plan (phase 2)

Grouped so each batch is one coherent change set:

| Batch | Theme | Effort | Impact |
|---|---|---|---|
| **A — Edges & elevation** | mode-polar `--fluux-border-color`, `--fluux-bg-float` token, FAB + panel seams | Small (token-level) + a few component swaps | **Highest** — fixes the FAB and every invisible-edge control/panel in dark mode at once |
| **B — Informational text** | `text-faint`/timestamps, light-mode link/self nudges | Small | High — timestamps & links become AA |
| **C — Sender + status palettes** | darken light-mode sender-1..6 + add light status overrides | Small (token-level) | High — MUC names & status legible in light |
| **D — De-hardcode colors** | substitute `--fluux-status-*` / `--fluux-modal-backdrop` | Medium (mechanical, many sites) | Med — theme correctness across all 13 themes |
| **E — Focus ring** | standardize `focus-visible` utility | Medium | Med — a11y |

**Recommended order:** A → C → B → E → D. A and C are small token edits with the largest perceptual payoff; D is the long mechanical tail.

### Suggested guardrail
The contrast math is deterministic. A small unit test that resolves the theme tokens and asserts AA on the informational-text and status pairings (and a minimum separation for border-on-surface) would prevent regressions — the same approach that already guards i18n and security iconography.

---

## 5. Appendix — measurement notes

- Accent fill contrast is healthy: white-on-accent **4.67:1 (dark) / 5.54:1 (light)** — AA. The existing `contrastColorForHsl()` machinery works; the gaps are in *non-accent* token placement.
- Light mode is consistently the weaker of the two — its surfaces sit in a narrow high-luminance band (`#E7EAF4`–`#FFFFFF`), so both colored text and surface separation have less room.
- All ratios above are exact WCAG 2.1, alpha tokens composited over their real backdrop, and were spot-validated against live `getComputedStyle` in the running app.
