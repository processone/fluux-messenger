# Admin User Management: Usable List (Design)

**Status:** design approved (2026-06-22) · **Target:** 0.17 · **Origin:** 0.17 admin program, function 2 (user management). Follows the server-overview pilot (PR #610).

## Goal

Make the admin **user list** actually usable: complete search across the whole user directory,
a real online/offline indicator per user, and a scannable last-login column so an admin can
eyeball dormant accounts at a glance. This is function 2 of the "make the existing ejabberd
admin panel friendly, function by function" program, building directly on the friendly kit
(`apps/fluux/src/utils/format.ts`) shipped with the overview.

Today the users category fetches one RSM page (`fetchUsers`) and filters only the loaded page
client-side (`AdminView.tsx` ~246, comment "client-side for now"). Search is therefore
incomplete (it misses users on unfetched pages), there is no online status, and there is no
last-login information. `UserListItem` renders just the bare JID.

## Scope

**In (this increment, "usable list first"):**
- Full-directory fetch with a bounded cap, cached for complete client-side search.
- Point-in-time online/offline indicator per row (one bulk fetch, stamped onto items).
- Lazy per-row last-login column (relative time, fetched on visibility, bounded queue, cached).
- Windowed rendering so the full in-memory set never dumps thousands of rows into the
  non-virtualized list.
- `formatRelativeTime` added to the friendly kit.
- New `admin.users.*` i18n keys with genuine translations in all 33 locales.
- Discovery-gating: every new capability silently no-ops on servers that do not advertise it,
  degrading to today's plain JID list.

**Out (deferred to later increments):**
- Detail-view moderation: ban/unban, kill sessions, resource/roster inspection. (`AdminUserView`
  already exists for add/delete/password; new moderation is explicitly out of scope here.)
- Whole-list sorting by last-login. Values load on demand, so a global sort is not possible
  without fetching the whole directory's last-activity. That is a later escalation.
- True server-side substring search (XEP-0055 or a custom ejabberd command). This is the future
  escalation path when a server outgrows the cap. The truncation banner is the hook for it.
- Live presence subscription / presence firehose. Online status is a snapshot, re-stamped only
  on manual refresh.

## Decisions (locked)

1. **Search mechanism:** full fetch plus cached client-side filter. Page the whole directory once,
   cache it, filter locally. Chosen because target servers are team/enterprise scale; portable,
   needs no server config. There is no standard ejabberd ad-hoc command for username substring
   search, so this is the pragmatic complete-search approach.
2. **`MAX_USERS` cap = 10,000**, paired with a large RSM page size (1000 to 2000 per page, giving
   roughly 5 to 10 sequential roundtrips, under a couple of seconds). Held in memory for search;
   cheap (a few MB) and sub-millisecond to filter. Past 10k is the server-side-search escalation
   territory the truncation banner flags. Exposed as a named, easily-tunable constant.
3. **Last-login = lazy list column now** (not detail-view-only). A scannable
   "online now / 2d ago / 3 months ago" cell is the core value of a usable list. Detail-view-only
   would force clicking into users one at a time and would add otherwise-out-of-scope detail
   surface. Not sortable across the whole list (values load on demand); that tradeoff is accepted.

## Approach (chosen)

**SDK owns all XMPP; the app renders.** Three focused SDK methods on `Admin.ts` (mirroring the
`fetchServerStats` pattern), new admin-store state for online JIDs plus per-JID last-activity, a
`requestLastActivity` action with a bounded concurrency queue, and presentation-only changes in
`UserListItem`, `AdminView`, and `EntityListView`. Every capability is discovery-gated.

## A. SDK API (`core/modules/Admin.ts`)

Three new methods, each gated on the relevant command/feature being advertised. On
unavailable/error they degrade rather than throw at the UI.

```ts
/** Loop fetchUserList over RSM pages (large page size) until complete or MAX_USERS reached. */
async fetchAllUsers(vhost?: string): Promise<{ users: AdminUser[]; truncated: boolean }>

/** XEP-0133 get-online-users-list -> Set of BARE online JIDs. Empty set if command unavailable. */
async fetchOnlineUserJids(vhost?: string): Promise<Set<string>>

/** XEP-0012 jabber:iq:last to a bare JID (mod_last). */
async fetchLastActivity(jid: string): Promise<LastActivityResult>
```

where `LastActivityResult = { seconds: number | null; unsupported: boolean }`:
- `unsupported: true` only for `feature-not-implemented` (server has no mod_last). This drives
  server-wide column suppression.
- `unsupported: false, seconds: null`: this user has no record, or a per-user error (column stays).
- `unsupported: false, seconds: N`: seconds since last logout.

The discriminated return is the **single public signature** (no bare `number | null` elsewhere),
so the hook can suppress the column on genuine absence without conflating it with per-user null.

Details:

- **`fetchAllUsers`** reuses the existing `fetchUserList(vhost, rsm)` (execute then complete, RSM
  via `buildRSMElement`/`parseRSMResponse`). It loops on `pagination.last` as the `after` cursor
  with a constant `USER_PAGE_SIZE` (1000 to 2000), accumulating `AdminUser[]`. It stops when a page
  returns no `last` cursor or fewer than a full page (complete), **or** when the accumulated count
  reaches `MAX_USERS` (10,000), in which case `truncated: true`. A defensive page-count guard
  (`ceil(MAX_USERS / USER_PAGE_SIZE)`) ensures a misbehaving server can never loop unbounded.
- **`fetchOnlineUserJids`** runs the XEP-0133 `get-online-users-list` ad-hoc command (same
  execute-then-complete shape as `fetchUserList`), parses the returned JIDs field, and **bares
  every JID** (strips resource) into a `Set<string>`. The command can return full JIDs with
  resources; baring lets the caller match against the bare JIDs in `AdminUser`. Returns an **empty
  set** when the command is not advertised/authorised (the caller treats empty as "no online info").
- **`fetchLastActivity`** sends `<iq type='get'><query xmlns='jabber:iq:last'/></iq>` to the bare
  JID and reads the `seconds` attribute (seconds since the user was last logged out;
  `0`/absent while online). Returns `{ unsupported: true, seconds: null }` only on
  `feature-not-implemented`; `{ unsupported: false, seconds: null }` on any other IQ error or a
  missing/unparseable `seconds`; otherwise `{ unsupported: false, seconds: N }`.

No new SDK store-binding methods are required: these are request/response methods the hook awaits
directly (like `fetchServerStats`), so the `client.ts` bindings interface, `defaultStoreBindings`,
and `test-utils.ts` fan-out do **not** apply here. (Confirm during implementation that no
`emitSDK` event path is added; if one is, the 3-place fan-out must be honored.)

## B. Types (`core/types/admin.ts`)

`AdminUser` already carries `jid`, `username`, `isOnline?`. No change needed to it; `isOnline` is
stamped by the app/hook from `fetchOnlineUserJids`.

Last-activity is **not** stored on `AdminUser` (it loads lazily and per-row; keeping it off the
entity avoids re-stamping the whole list). It lives in a dedicated store map (section C) with a
small typed cell:

```ts
/** Result of an XEP-0012 last-activity query (discriminates feature-absent from per-user null). */
export interface LastActivityResult {
  /** Seconds since last logout; null = unknown for this user. */
  seconds: number | null
  /** True only when the server returns feature-not-implemented (no mod_last). */
  unsupported: boolean
}

/** Lazy per-JID last-activity cell held in the admin store for the user list. */
export interface LastActivityEntry {
  /** 'loading' while in flight; 'loaded' once resolved (value may still be null = unknown). */
  state: 'loading' | 'loaded'
  /** Seconds since last logout; null = unknown/unavailable; 0 (or online) handled at render. */
  seconds: number | null
}
```

## C. Admin store (`stores/adminStore.ts`)

Add, alongside `userList`:

- `onlineJids: Set<string>`: bare online JIDs from the last snapshot. Setter `setOnlineJids`.
- `lastActivity: Map<string, LastActivityEntry>`: per-JID lazy cell. Updated via a single
  `setLastActivity(jid, entry)` action that replaces the map (new `Map` reference) so per-key
  subscribers re-render.
- `lastActivitySupported: boolean` (default `true`): flipped to `false` the first time
  `fetchLastActivity` returns the unavailable signal, so the column stops rendering and stops
  requesting. Setter `setLastActivitySupported`.
- `usersTruncated: boolean`: set from `fetchAllUsers`. Drives the truncation banner.

`reset()` and the vhost-switch path must clear `onlineJids`, `lastActivity`,
`lastActivitySupported` (back to `true`), and `usersTruncated`.

> Note: list-item subscriptions read `lastActivity.get(jid)` per row (per-key, not the whole map)
> per the project render-perf rule. Each `setLastActivity` replaces the Map reference but only the
> affected row's selector value changes, so only that row re-renders.

## D. Hook (`hooks/useAdmin.ts`)

- **Replace one-page entry with full fetch.** Entering the users category calls a new
  `fetchAllUsers()` (wraps `client.admin.fetchAllUsers`): it sets `userList.items` to the full set,
  `usersTruncated`, `hasFetched`, and clears loading/error. Then it calls `fetchOnlineUserJids()`
  and **stamps `isOnline`** onto each item once (single map over the cached set), and stores
  `onlineJids`. This is a point-in-time snapshot; manual refresh re-runs both.
- **`requestLastActivity(jid)`**: idempotent action behind a bounded queue:
  - No-op if `!lastActivitySupported`, if an entry already exists (`loading`/`loaded`), or if the
    user is currently online (online overrides last-login; never query).
  - Otherwise mark `{ state: 'loading', seconds: null }`, enqueue, and drain behind a concurrency
    cap (`LAST_ACTIVITY_CONCURRENCY`, about 6 in flight) so fast scrolling never floods the server.
  - On resolve: `setLastActivity(jid, { state: 'loaded', seconds })`. If any resolution returns
    `unsupported: true`, call `setLastActivitySupported(false)`, drop the queue, and stop firing
    further requests. (Because `fetchLastActivity` carries the discriminated `unsupported` flag,
    the hook never has to conflate feature-not-implemented with a per-user null, so there is no
    special-casing of "the first resolution".)
- Keep `searchUsers` honest: the existing stub claims server-side search "if supported" but does
  not. Either delete it or repoint it to set `userList.searchQuery` for the now-complete
  client-side filter. (The filter itself stays in `AdminView`; see E.)
- `loadMoreUsers` against the network is no longer the users-list paging mechanism (full fetch
  replaces it). The list's "load more" becomes **client-side windowing** (section F). Leave the
  rooms list's network `loadMoreRooms` untouched.

New tunable constants (SDK module): `MAX_USERS = 10000`, `USER_PAGE_SIZE` (1000 to 2000),
`LAST_ACTIVITY_CONCURRENCY = 6`.

## E. Search over the full set (`AdminView.tsx`)

The client-side filter at ~246 stays but now runs over the **complete** cached set, so the
"(client-side for now)" caveat is removed and search is genuinely complete. Behaviour is unchanged
otherwise (case-insensitive substring over `jid` plus `username`).

## F. Windowed rendering (`EntityListView.tsx` plus `AdminView` wiring)

`EntityListView` is **generic and shared** by both the users and rooms lists; its load-more
`IntersectionObserver` currently fires a **network** `onLoadMore`. We must not break the rooms
list's real network paging. So windowing is **opt-in**, not a rewrite of the shared contract:

- The users list passes the full `filteredUsers` but renders only a growing local slice
  (`items.slice(0, visibleCount)`), and the existing load-more observer increments `visibleCount`
  locally (no network). `hasMore` for users = `visibleCount < filteredUsers.length`.
- Window resets to the initial size when the filter query changes or the category/vhost changes.
- The rooms list keeps windowing off and continues to use network `onLoadMore`.

Decide in the plan whether the slice state lives in `AdminView` (cleanest, no shared-contract
change) or behind a `windowed?` prop on `EntityListView`. Default: keep it in `AdminView` to avoid
touching the shared component's behaviour for rooms.

## G. Row UI (`components/UserListItem.tsx`) plus formatter

`UserListItem` (currently just the JID) gains:

- **Presence dot** at the start: green when `user.isOnline`, gray otherwise. `aria-label` for
  online/offline.
- **JID** (unchanged, truncating).
- **Right-aligned last-login cell:**
  - `user.isOnline`: "Online now" (online overrides last-login; no query fired).
  - else subscribe to `useAdminStore(s => s.lastActivity.get(user.jid))` (per-key):
    - undefined or `state==='loading'`: skeleton.
    - `state==='loaded'`, `seconds!=null`: `formatRelativeTime(...)` (for example "2d ago").
    - `state==='loaded'`, `seconds===null`: render nothing (unknown for this user).
  - whole cell omitted when `!lastActivitySupported`.
  - **Absolute timestamp on hover** (title/tooltip) computed from `Date.now() - seconds*1000`.
- **Lazy trigger:** a one-shot `IntersectionObserver` on the row fires `requestLastActivity(jid)`
  on first visibility (skipped when online or unsupported). The row subscribes only to its own
  key, per the list-item subscription rule.

`UserListItem` becomes a `memo` row reading its own store key (not a list-wide Map) to keep
re-renders bounded during the lazy-fill burst.

**New formatter (`utils/format.ts`):**

```ts
/** Seconds-ago -> friendly relative string ("just now", "5m ago", "2d ago", "3mo ago"). */
export function formatRelativeTime(secondsAgo: number, labels: RelativeTimeLabels): string
```

Follows the kit convention: pure, no i18n coupling. The caller passes localized unit labels
(like `formatDuration`'s `DurationUnits`). Buckets: just-now (under 60s), minutes, hours, days,
then weeks/months as appropriate; show a single coarse unit (admin scanning, not precision).

## H. i18n

New keys under `admin.users.*` (and any cell labels), for example `onlineNow`, `offline`,
`lastSeenUnknown`, relative-time unit labels, and `truncatedBanner` (with `{{shown}}`/`{{total}}`
interpolation). Genuine translations in **all 33 locales** (`i18n.test.ts` enforces parity).
No em-dashes or en-dashes in any user-facing value (and avoid them in prose). Scan new values for
`[em-dash or en-dash]` before commit.

## I. Edge cases

- **Truncated full fetch:** show a banner ("Showing first N of M; refine your search to narrow
  results") instead of silently cutting off. This banner is the natural future hook for true
  server-side search. Total (`M`) comes from `serverStats?.registeredUsers` when available.
- **Vhost switch:** re-runs the full fetch and clears `onlineJids`, `lastActivity`,
  `lastActivitySupported`, `usersTruncated`, and the window slice.
- **Online overrides last-login** text and suppresses the per-user last-activity query.
- **Missing commands degrade.** When the online command is unavailable, `onlineJids` is empty;
  hide the presence dot rather than show everyone gray (decided here, not deferred). When mod_last
  is absent, the column is suppressed after the first unavailable resolution. Result: today's plain
  JID list.
- **Fast scrolling:** the concurrency cap plus idempotent dedupe prevent request floods; rows that
  scroll past before resolving still resolve (cached) and render correctly if revisited.

## J. Testing

**SDK (`Admin.ts`):**
- `fetchAllUsers`: multi-page accumulation via mocked RSM pages; stops at completion; stops at
  `MAX_USERS` with `truncated: true`; page-count guard.
- `fetchOnlineUserJids`: parses JIDs field, bares resources, dedupes into a Set; empty set on
  unavailable command.
- `fetchLastActivity`: parses `seconds`; `{ unsupported: true }` on feature-not-implemented;
  `{ unsupported: false, seconds: null }` on IQ error or missing attr; numeric on success.

**App:**
- `UserListItem` row states: online dot, "Online now", skeleton, relative time, null renders
  empty, hover absolute title, column hidden when unsupported.
- Lazy queue: dedupe (no double request per jid), concurrency cap respected, unavailable
  suppression (an `unsupported` resolution stops further requests and hides the column).
- Search completeness over the full cached set (a user present only on a "later page" is found).
- Windowed rendering keeps DOM bounded (slice grows on observer; rooms list network paging
  unaffected).
- `formatRelativeTime` bucket boundaries.

App tests mock `@fluux/sdk`; any new exports (types, the three methods on the admin client mock,
new store fields/actions) must be added to the test mock via `importOriginal` spread. After
changing SDK types/exports, run `npm run build:sdk` before app typecheck (and, in this worktree,
sync the built dist as noted in project memory).

## Files touched

- `packages/fluux-sdk/src/core/modules/Admin.ts`: three new methods plus constants.
- `packages/fluux-sdk/src/core/types/admin.ts`: `LastActivityResult` and `LastActivityEntry`.
- `packages/fluux-sdk/src/stores/adminStore.ts`: `onlineJids`, `lastActivity`,
  `lastActivitySupported`, `usersTruncated`, their setters, and reset wiring.
- `packages/fluux-sdk/src/hooks/useAdmin.ts`: `fetchAllUsers` (replaces one-page entry),
  `requestLastActivity` queue, search/loadMore adjustments.
- `apps/fluux/src/components/AdminView.tsx`: full-fetch wiring, complete search, windowing,
  truncation banner.
- `apps/fluux/src/components/EntityListView.tsx`: opt-in windowing support (only if not handled
  entirely in AdminView).
- `apps/fluux/src/components/UserListItem.tsx`: presence dot, last-login cell, lazy observer.
- `apps/fluux/src/utils/format.ts`: `formatRelativeTime`.
- `apps/fluux/src/i18n/locales/*`: `admin.users.*` keys in all 33 locales.

## Next steps (later increments)

- Detail-view moderation (ban/unban, kill sessions, resource/roster inspection).
- True server-side search (XEP-0055 or a custom ejabberd command) behind the truncation banner.
- Optional: whole-list last-login sort once a server-side last-activity batch exists.
