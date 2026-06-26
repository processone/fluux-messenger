# Aurora — Screen Inventory & Rework Roadmap

- Status: Living roadmap
- Date: 2026-06-26
- Companion to: `2026-06-26-aurora-design-direction.md` (the design spec)
- Scope: `apps/fluux` (the reference client)

## Purpose

P0 landed the Aurora identity at the token layer (ramp, accent, sender palette, elevation, display font) plus avatar shapes, accent badges, and the app icon (#655). The follow-up added the reduce-motion setting and the Indigo theme (#657).

What's left is **applying Aurora screen by screen** so each view is genuinely beautiful, not just recolored. This document is the prioritized work-list: we always pick the highest-impact screen next and run it as one plan-and-build cycle (spec slice → plan → subagent-driven build → review → PR), the same flow that shipped P0.

## How to read this

Each screen lists:
- **Issues** — what's wrong today (from the audit + current code).
- **Target** — the Aurora end state.
- **Effort** — S (≈1 PR / <1 day), M (1–2 PRs), L (multi-step).
- **Phase** — maps to the design spec's P1–P4.

Priority order is top-to-bottom: highest payoff first. Reorder freely as priorities shift.

## Cross-cutting (do alongside the screens that surface them)

- **Apply the display font.** Inter Tight is registered (P0) but applied nowhere yet. Apply to view titles, headers, and section labels as each screen is reworked.
- **Density modes.** Add a comfortable/compact setting (spec §6) driving a `data-density` attribute; consumed by list/message/occupant rows. Lands with the chrome screens (#3/#4).
- **Motion language.** Now that reduce-motion exists (#657), add tasteful micro-motion (spring reactions, send animation, view transitions) as screens are touched. Everything gates on `data-motion`.
- **Sender palette application.** The `--fluux-sender-*` tokens exist but names still use the legacy XEP-0392 consistent-color algorithm. Applied first in the message list (#1), then anywhere a name is colored.
- **Render-perf discipline.** Every screen keeps the existing memo/subscription patterns (id-list + per-row self-subscribe; `roomSenderResolution`, `occupantGrouping`); add render-count guards for new hot paths.

---

## 1. Message list & bubbles — `ChatView` / `RoomView` / `conversation/*`
**Phase P1 · Effort L · Highest payoff (most-viewed surface)**

- **Issues:** Two different message languages — 1:1 is spacious (avatar + name on nearly every row), rooms are compact/grouped; no shared grammar. Sender names use arbitrary consistent-color, not the curated palette. No own-message luminous edge. The "new messages" divider is alarm-red. Loose vertical rhythm in 1:1.
- **Target:** One unified grouped grammar across 1:1 and rooms — group consecutive same-sender messages within 5 min, avatar/name once per run, subsequent rows in the same gutter. Own messages get the luminous left-edge (accent tint + 2px accent border), name in `--fluux-text-self`. Sender names from `--fluux-sender-1..6` (deterministic by bare JID). Accent "new messages" divider; hairline date dividers. Tuned density. Reactions as L3 pills; reply quote with accent left-rule; mention chip; whisper in reserved violet; per-message encryption shield in the meta line. Image/link cards get rounded frames (fix the heavy black image frame).
- **Notes:** Reuse `roomSenderResolution.ts`; extend message-row memo guards; bubbles were rejected in favor of flat grouped rows.

## 2. Composer + chat/room header — `MessageComposer` / `RoomMessageInput` / `ChatHeader` / `RoomHeader`
**Phase P2 · Effort M**

- **Issues:** Composer is a heavy full-width bar (especially in light); attach / emoji / send don't read as one considered cluster. Headers are functional but plain.
- **Target:** Contained composer "card" (L3) inset from the edges, hairline that becomes an accent focus-edge on focus; a tidy action cluster; the reply/whisper context chip docks inside the card above the input. Header name in the display font, presence as a ringed dot, a cleaner action row. Density-aware min-height.

## 3. Conversation/room list + icon rail — `Sidebar` / `sidebar-components/ConversationList` / `RoomsList`
**Phase P2 · Effort M**

- **Issues:** Competent but generic chrome; no density control; section headers inconsistent.
- **Target:** Aurora chrome — rail brand mark, active item = accent-soft + 2px inset accent edge, unread = accent badge (done in P0), display-font list titles, search as an inset pill. Introduce comfortable/compact **density modes** here. Keep the id-list-subscription + per-row self-subscribe perf pattern.

## 4. Occupant / members panel — `OccupantPanel` / `MemberList` / `FullScreenOccupantPanel`
**Phase P2 · Effort S–M**

- **Issues:** Works; visually plain; presence is a flat dot.
- **Target:** Small-caps group labels on hairlines (reuse `occupantGrouping.ts`), 28px avatars in sender hues, ringed presence dots (green/amber/red), names in identity color, role tags. Keep `roomSenderResolution` so only the flapped occupant's rows re-render.

## 5. Modals & command palette — `ModalShell` / `ModalHost` / `CommandPalette` (+ the ~24 modals)
**Phase P3 · Effort M**

- **Issues:** Standard modals; no depth/glass language; form fields and buttons aren't a shared system.
- **Target:** The Aurora overlay system — dimmed backdrop, raised L4 surface, hairline, overlay shadow, radius-xl, footer-anchored actions with the accent-gradient primary + danger variant. Shared form-field + button + segmented-control + switch components. **Command palette** gets the glass treatment (translucent L4 + blur + luminous search row). Define once in `ModalShell`/`ModalHost`.

## 6. Empty states & side panels — `ContactProfileView` / `SearchView` / various empties
**Phase P4 · Effort S–M**

- **Issues:** Contact profile leaves a large void on the right; empty states are functional placeholders.
- **Target:** Restrained, centered empty states (a faint line/gradient mark + one-line prompt + a primary action). Collapse the contact panel until a contact is selected, or fill it with a meaningful default.

## 7. Settings & admin — `SettingsView` / `settings-components/*` / `AdminView` / `admin/*`
**Phase P4 · Effort M**

- **Issues:** Functional and dense; Appearance is partly Aurora already (mode, motion, themes). Admin is utilitarian.
- **Target:** Apply Aurora chrome + type consistently across settings categories. Admin adopts Aurora visuals; the broader admin "friendly kit" remains its own track (see the admin-panel roadmap) but should ride the same components.

## 8. Auth surfaces — `LoginScreen` / `LoginErrorPanel`
**Phase P4 · Effort S**

- **Issues:** First impression; currently plain.
- **Target:** Aurora-branded login (gradient mark, deep-ink/cool-white surface, display-font heading), refined error panel. Low traffic but it's the first screen a new user sees.

---

## Suggested sequencing

1. **#1 Message list** (P1) — the flagship; everything else reads as polish next to it.
2. **#2 Composer + headers** then **#3 list/rail** (P2 chrome) — ship density modes with #3.
3. **#4 Occupant panel** (P2).
4. **#5 Modals + command palette** (P3) — establishes the shared overlay/component kit the later screens reuse.
5. **#6 Empty states**, **#7 settings/admin**, **#8 auth** (P4 polish).

Each item becomes its own design-slice → plan → build → PR. Update this file as screens land (mark done, add discoveries).
