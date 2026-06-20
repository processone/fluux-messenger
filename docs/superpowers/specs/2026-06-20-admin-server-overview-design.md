# Admin Server Overview + Friendly Kit — Design

**Status:** design approved (2026-06-20) · **Target:** 0.17 · **Origin:** ROADMAP_2026 priority 1 (admin console)

## Goal

Make the existing ejabberd admin panel **user-friendly, function by function**. This spec covers
the **pilot function: the server overview**, plus the **reusable "friendly kit"** that every
subsequent admin function will build on.

Today the admin panel works but exposes raw server vocabulary: the `stats` category lists raw
command nodes (`get-registered-users-list`, `muc_online_rooms_count`), `DataFormFields` falls back
to `field.var` (`registeredusersnum`, `accountjids`), and `AdminCommandResult` dumps label/value
flat (uptime in raw seconds, unlocalized counts, booleans as `0/1`). We replace the `stats`
category with a readable **vital-signs dashboard**, and extract the formatting + labelling
primitives into a shared kit.

## Scope

**In (0.17 pilot):**
- Server overview screen with curated vital-signs cards, discovery-driven.
- Reusable formatter kit (`utils/format.ts`) + declarative card registry.
- New SDK method `fetchServerStats()` returning a typed `ServerStats`.
- "Advanced" disclosure retaining the existing raw stats command runner (no capability lost).
- Manual + on-open refresh. i18n in all 33 locales.

**Out (deferred — see "Next steps"):**
- s2s / cluster / active-users-over-period / per-vhost breakdown (→ full ops dashboard).
- Trends / sparklines / local history sampling.
- Auto-poll / live refresh.
- Wiring the kit into the generic `DataFormFields`/`AdminCommandResult` runner (that is the cheap
  follow-on that lifts every still-generic function; intentionally not in the bounded pilot).

## Approach (chosen)

**SDK returns structured stats; app renders curated cards.** The SDK keeps all XMPP knowledge
(stanza parsing, command discovery); the app receives a typed object and renders presentation only.
This honours the SDK/app boundary and yields a kit (typed formatters + label maps) that the next
functions reuse directly.

## A — UX / screen

The `stats` category becomes the **server overview** and is the landing screen when an admin opens
the panel (today the default main content is a "select a command" placeholder).

- **Responsive grid of vital-signs cards.** Each card: icon + human label + large formatted value +
  optional sub-label/unit. Per-card loading skeleton.
- **Header:** title + **Refresh** button showing "updated Xs ago" + vhost selector reused when >1 vhost.
- **"Advanced" disclosure** at the bottom retaining the current raw stats command list
  (`commandsByCategory.stats` runner) → nothing lost for power users.
- **Discovery-driven:** a card renders only when the server provides that metric.

Cards: **Uptime** · **ejabberd version** · **Registered users** · **Online users** ·
**Online rooms** · **Virtual hosts**.

**Routing change:** the `stats` category stops expanding a raw command sub-list in the sidebar
(`AdminDashboard`) as its primary affordance; like `users`/`rooms` it becomes a non-expanding
category that drives the main panel. `AdminView.renderContent()` renders `<ServerOverview>` when
`activeCategory === 'stats'`. The raw command list relocates into the overview's "Advanced"
disclosure. `ChatLayout.adminHasMainContent` gains `|| adminCategory === 'stats'`.

## B — SDK API (`fetchServerStats`)

New method on `core/modules/Admin.ts`:

```ts
async fetchServerStats(vhost?: string): Promise<ServerStats>
```

New type in `core/types/admin.ts` (every metric optional → discovery-driven omission):

```ts
interface ServerStats {
  uptimeSeconds?: number
  version?: string
  registeredUsers?: number
  onlineUsers?: number
  onlineRooms?: number
  vhostCount?: number
  fetchedAt: number
}
```

- **Supersedes `fetchEntityCounts`** (which currently feeds the dashboard count badges) to avoid two
  overlapping fetches: the badges read `users`/`onlineUsers`/`rooms` from `serverStats`.
- Each metric wrapped in an **independent try/catch** (same pattern as today's `fetchEntityCounts`):
  one missing/forbidden command never sinks the others; missing → field omitted.
- Emits `admin:server-stats` → `adminStore.serverStats`; `useAdmin()` exposes `serverStats`,
  `fetchServerStats`, `isLoadingStats`. Reuses existing `executeSimpleCommand` /
  `executeApiCommand` helpers.

**Data sources** (per metric). Confirmed against the live process-one.net ejabberd via a session
console export (2026-06-20): the server advertises `jabber:iq:version` (mod_version active) and
`http://jabber.org/protocol/commands`. ⚠ = still to confirm live (the export did not include admin
command traffic).
| Metric | Source |
|---|---|
| registeredUsers | XEP-0133 `get-registered-users-num` → field `registeredusersnum` |
| onlineUsers | XEP-0133 `get-online-users-num` → field `onlineusersnum` |
| onlineRooms | ejabberd api-command `muc_online_rooms_count` (existing path in `fetchEntityCounts`) |
| vhostCount | `fetchVhosts().length` (existing) |
| uptimeSeconds | ejabberd api-command `stats` with `name=uptimeseconds`. ⚠ Parse the returned value **tolerantly** — read the single non-fixed value field rather than hard-coding its `var` (`stat`/`res`/etc. unconfirmed). |
| version | **Confirmed:** XEP-0092 `jabber:iq:version` to the domain bare JID (`<name>ejabberd</name><version>…</version>`). mod_version advertised on process-one.net. |

## C — Friendly kit (reusable foundation)

- **`apps/fluux/src/utils/format.ts`** (new): pure, unit-tested formatters —
  `formatDuration(seconds)` (→ "3j 4h 12min"), `formatCount(n)` (localized), `formatBytes(n)`,
  `formatBoolean(v)`, `formatDateTime(ts)`. These are what Announcements / Room config / deep user
  management reuse next.
- **Card registry** (`apps/fluux/src/components/admin/adminOverview.ts`): declarative array of
  `{ key: keyof ServerStats, icon, labelKey, format }`; the overview maps over it and skips entries
  whose value is `undefined` (discovery-driven).
- **i18n:** new `admin.overview.*` keys (card labels, units, refresh, "updated Xs ago", "Advanced",
  empty/error) in all 33 locales — `i18n.test.ts` parity test enforces presence (real translations,
  no placeholders).

## D — States & refresh

- Metric `undefined` → card omitted. Whole-fetch failure (not admin / disconnected) → friendly empty
  state with "Retry".
- Refresh: manual button + on category open; button disabled while loading; shows relative
  "updated Xs ago" from `fetchedAt`.
- No auto-poll in 0.17 (YAGNI; listed in Next steps).

## E — Testing & verification

- **SDK** `Admin.test.ts`: `fetchServerStats` parsing — mock IQ results → structured object; a
  missing command → that field omitted, others still present; `fetchedAt` stamped.
- **App** `format.test.ts`: each formatter incl. edge cases (0, large numbers, sub-minute durations,
  locale). Overview render test: cards shown/omitted by metric presence; Refresh calls the fetch;
  empty state when not admin.
- **Demo mode:** seed `DemoClient` to answer the stat commands (and XEP-0092 version) so the overview
  is demo-able + screenshot-able and verifiable. Confirm whether `DemoClient` already stubs admin
  disco before adding.
- Typecheck + lint + full test suite green (incl. i18n parity) before commit (per CLAUDE.md).

## Architecture seam & isolation

- `ServerStats` + `fetchServerStats` = the single typed contract between SDK and app for the overview.
- The app's `ServerOverview` knows nothing about XMPP; it renders `ServerStats` through the registry
  + formatters. The kit (`format.ts`) has zero admin coupling → directly reusable.
- "Advanced" reuses the existing `AdminCommandForm`/runner unchanged.

## Next steps (admin friendliness backlog, after the pilot)

Reuse the kit, one function at a time:
1. **Announcements / MOTD** — friendly broadcast / message-of-the-day / welcome composer (preview,
   target vhost/all, confirmation) replacing the generic runner for announcement commands.
2. **Room config** — readable grouped MUC settings screen (human labels, sections, defaults, help)
   replacing the raw XEP-0004 dump.
3. **Deep user management** — server-side search (vs current client-side filter), last-login +
   online-status columns, ban/unban, resources/sessions.

Larger admin increments (deferred): full **ops dashboard** (s2s, cluster, active users, per-vhost,
trends); **invitation link generation** (design: `docs/2026-06-09-invitation-flow-design.md`, issue
#16); **mod_push** configuration (premature until mobile/push lands).

Cheap cross-cutting follow-on: wire the kit's label/formatter maps into
`DataFormFields`/`AdminCommandResult` so every still-generic function gains human labels + formatted
values at once.
