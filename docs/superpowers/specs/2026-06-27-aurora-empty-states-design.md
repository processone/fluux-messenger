# Aurora Empty States and Side Panels — Design Spec

- Status: Approved (design + full-sweep scope), pending spec review
- Date: 2026-06-27
- Screen: #6 in `2026-06-26-aurora-screen-inventory.md` ("Empty states & side panels")
- Scope: `apps/fluux` — every empty state in the app (full sweep, 13 surfaces), via 2-3 shared components

## Goal

Make every empty state in the app a calm, intentional Aurora composition instead of a flat gray placeholder: a faint accent mark, a display-font title, a one-line prompt, and — where the space is actionable — a primary action that gives it somewhere to go. The contact-profile "void" and the high-visibility no-selection panes are the headline; the scattered list placeholders become consistent.

## Background — what exists today

- **A shared `EmptyState`** (`ChatLayout.tsx:930-1008`) already drives the 7 main-area no-selection states (messages, rooms, directory, archive, events, search, admin) — a flat `size-24 bg-fluux-sidebar` gray circle + `size-12` lucide icon + `text-xl` title + description. Plus `AdminEmptyState` (`ChatLayout.tsx:1015-1047`).
- **List/inline empties are ad-hoc and mostly plain gray text**, each different: conversation list (`ConversationList.tsx:88`), archive (`:160`, has icon), contacts no-contacts + no-matches (`ContactList.tsx:143/147`), rooms list (`RoomsList.tsx:178`, has icon + a "create room" button — the most polished), admin entity lists (`EntityListView.tsx:87`), search no-results / initial-hint (`SearchView.tsx:212/315`), events (`EventsView.tsx:79`, renders `null`).
- **Message-empty** (chat/room, no messages): text-only centered (`RoomView.tsx:957`, `ChatView`/`MessageList`).
- **Aurora identity is unused in empties:** `--fluux-grad` and accent-2 are defined but applied to zero empty states; everything is flat gray.

## Design

Three shared building blocks, applied across all 13 surfaces. No bespoke per-surface designs.

### 1. Redesigned shared `EmptyState` (the 7 main-area states)

The component keeps its `switch(sidebarView)` content map; only the presentation + an optional action change.

- **The mark (theme-robust):** replace the flat `bg-fluux-sidebar` gray circle with a faint **accent**-tinted disc — a soft tint of the theme's own accent (e.g. `bg-fluux-brand/10` to `/15`) with a hairline accent border (`border-fluux-brand/30`), and the state's lucide icon rendered in the accent (`text-fluux-brand`). This is theme-aware (each theme's accent), unlike the fixed `--fluux-grad` (Aurora-only multi-hue, no theme overrides it — NOT used for the mark). Size ~`size-20`/`size-22`.
- **Title:** the existing title copy, in the display font (`font-family: var(--fluux-font-display)`), `text-xl`/`text-2xl`, `text-fluux-text`.
- **Prompt:** the existing description copy (already ~one line), `text-fluux-muted`, `max-w-sm`. Keep existing hints where present (no copy rewrites — see i18n note).
- **Primary action (new, actionable states only):** a single accent primary button (solid `bg-fluux-brand` fill, `text-fluux-text-on-accent`, matching the composer filled-send / modal primary) under the prompt:
  - `messages` (no conversation) → "Start a conversation" → navigates to the contact **directory** view (the people list, where a conversation is started), via the same sidebar-nav action the rail uses (`navigateTo('directory')` / the app's view-switch handler). NOT `onStartConversation(jid)` — that needs a specific JID; this is the "go pick someone" entry. The implementer confirms the exact view-switch handler available to `EmptyState`.
  - `rooms` (no room) → "Create a room" → opens the existing create-room flow (`setShowCreateRoom`, the same one `RoomsList`'s empty-state button uses).
  - `directory`, `archive`, `events`, `search`, `admin` → **no action** (informational; selecting from the sidebar IS the action, or the state is purely status).
- `AdminEmptyState` adopts the same mark + type treatment (no action; keep its access-denied branch).

### 2. New shared `ListEmpty` primitive

A small, centered, reusable component for in-list / in-panel empties — one consistent look replacing the scattered plain-text branches.

- **Props:** `{ icon: LucideIcon; title: string; description?: string; action?: { label: string; onClick: () => void } }`.
- **Composition:** centered column, the icon at `size-10`/`size-12` in `text-fluux-muted` (or a faint accent for emphasis), `text-fluux-muted` title, optional smaller description, optional secondary action button (the `RoomsList` "create room" button style: `text-fluux-brand bg-fluux-brand/10`).
- **Applied to (reuse existing copy keys; no new copy except where a surface had none):** conversation list, contacts (no-contacts + no-matches), archive list, rooms list (migrate its existing icon+text+button into the primitive), admin `EntityListView`, search no-results, search initial-hint, and **events** (replace the bare `null` with a quiet ListEmpty so the events pane reads intentionally when empty).

### 3. Message-empty (chat + room)

- The "no messages yet" centered state (`chat.noMessages`) adopts a small faint accent mark + the existing copy, the same calm composition (smaller scale than the main EmptyState). The room not-joined warning (`rooms.notJoinedNoHistory` / `rooms.joinToLoadHistory`, amber `AlertCircle`) is preserved as-is.

## Copy / i18n

- **Keep all existing titles, descriptions, hints, and list-empty strings** — no rewrites (avoids churn across 33 locales and the existing copy is already concise).
- **New keys (minimal):** the 2 primary-action labels — `emptyState.messages.action` ("Start a conversation") and `emptyState.rooms.action` ("Create a room") — added to all 33 locales with genuine translations. Any surface that genuinely had no string today (none required new copy except optionally the events ListEmpty title, which can reuse an existing events key) is called out in the plan.
- No em-dashes / en-dashes in any new string.

## Theme-robustness + guard

- The decorative mark uses the theme's **accent** (`fluux-brand` tints), so it tints per theme — never the fixed `--fluux-grad`.
- The **text** (title + prompt) must clear WCAG AA on the empty-state surface in all 13 themes × 2 modes. The main `EmptyState` renders on the conversation/main surface (`--fluux-chat-bg`), whose `text-normal` / `text-muted` contrast is already guarded by `themeContrast.test.ts`. Confirm during implementation that the surfaces used are covered; if an empty renders on a different surface (e.g. the sidebar for list empties), ensure that surface's `text-muted` contrast is guarded (extend the guard if not).
- The **primary action** button is the theme accent fill with `--fluux-text-on-accent`; `--fluux-accent-l` is globally tuned so white-on-accent clears AA (existing invariant) — reused, not re-tuned.

## Testing

- Unit: `EmptyState` renders the mark + title + prompt for each `sidebarView`, AND renders the primary action for `messages`/`rooms` while NOT rendering one for the informational states. `ListEmpty` renders icon + title (+ optional description/action). Clicking the actions calls the wired handlers.
- Cross-theme: confirm the empty-state text is AA on its surface across all 13 themes × 2 modes (reuse / extend the `themeContrast` text-on-surface coverage).
- Screenshots: the contact-profile (directory) empty, the no-conversation empty (with action), the no-room empty (with action), a list empty, and the message-empty — in Aurora dark + light + 1-2 accent themes (e.g. gruvbox, dracula) to confirm the accent mark tints per theme and text stays readable.

## Out of scope

- No new conversation/room creation FLOWS — the primary actions reuse existing handlers only.
- No copy rewrites beyond the 2 action labels.
- No SDK changes. No changes to loading / error transient states (only true empty states).
