# Admin User Management: Usable List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin user list usable: complete client-side search over the full user directory, a real online/offline indicator per row, and a lazily-loaded last-login column, all discovery-gated.

**Architecture:** The SDK gains three roster-independent request/response methods on `Admin.ts` (full paged fetch, bulk online JIDs, per-user last activity) plus a small standalone bounded-concurrency queue. The admin store holds online JIDs and a per-JID last-activity map. The app renders a presence dot and a lazy last-login cell per row, windows the full in-memory list so the DOM stays bounded, and runs the existing client-side filter over the now-complete set.

**Tech Stack:** TypeScript, React, Zustand vanilla stores, Vitest, @xmpp/client (ltx elements), i18next (33 locales).

## Global Constraints

- No em-dashes or en-dashes in any user-facing text, and avoid them in prose. Scan new values before commit.
- New i18n keys require genuine translations in all 33 locale files under `apps/fluux/src/i18n/locales/`; `i18n.test.ts` enforces key parity.
- List-item components must use per-key store subscriptions (`useAdminStore(s => s.map.get(key))`), never list-wide Map subscriptions (render-perf rule).
- After changing SDK types/exports, run `npm run build:sdk` before app typecheck. This is a git worktree: the app resolves `@fluux/sdk` to the MAIN repo's `dist`, so the built dist must be synced to `/Users/mremond/AIProjects/fluux-messenger/packages/fluux-sdk/dist` (Task 7).
- `MAX_USERS = 10000`, `USER_PAGE_SIZE = 1500`, `LAST_ACTIVITY_CONCURRENCY = 6` (named constants).
- Tests, typecheck, and lint must pass with no stderr before any commit. Never include a Claude footer in commits or PRs.
- Reuse the friendly kit in `apps/fluux/src/utils/format.ts`. The existing `LastActivity.ts` module is roster-coupled (`queryLastActivity` returns null unless the JID is an offline roster contact) and is deliberately NOT reused here, since admin lists arbitrary server accounts.

---

## File Structure

**SDK (`packages/fluux-sdk/src/`):**
- `core/modules/Admin.ts` (modify): add `fetchAllUsers`, `fetchOnlineUserJids`, `fetchLastActivity` + `MAX_USERS`/`USER_PAGE_SIZE` constants.
- `core/types/admin.ts` (modify): add `LastActivityResult`, `LastActivityEntry`.
- `core/admin/lastActivityQueue.ts` (create): standalone bounded-concurrency queue, fully unit-tested.
- `stores/adminStore.ts` (modify): add `onlineJids`, `lastActivity`, `lastActivitySupported`, `usersTruncated` + setters + reset wiring.
- `hooks/useAdmin.ts` (modify): `fetchAllUsers` action (replaces one-page entry) + online stamping + `requestLastActivity`.
- `index.ts` (modify): export the two new types.

**App (`apps/fluux/src/`):**
- `utils/format.ts` (modify): add `formatRelativeTime` + `RelativeTimeLabels`.
- `hooks/useWindowedList.ts` (create): generic incremental-window hook, unit-tested.
- `components/UserListItem.tsx` (modify): presence dot + lazy last-login cell.
- `components/AdminView.tsx` (modify): full-fetch wiring, complete search, windowing, truncation banner.
- `test-setup.ts` (modify): extend the `@fluux/sdk` mock with new store fields/actions.
- `i18n/locales/*.json` (modify): `admin.users.*` keys in all 33 locales.

---

## Task 1: SDK `fetchAllUsers` (full paged fetch + cap)

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Admin.ts` (after `fetchUserList`, ~line 693)
- Test: `packages/fluux-sdk/src/core/modules/Admin.test.ts`

**Interfaces:**
- Consumes: existing `fetchUserList(vhost?, rsm?: RSMRequest): Promise<{ users: AdminUser[]; pagination: RSMResponse }>`.
- Produces: `fetchAllUsers(vhost?: string): Promise<{ users: AdminUser[]; truncated: boolean }>`; exported constants `MAX_USERS = 10000`, `USER_PAGE_SIZE = 1500`.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('User Management'...)` block in `Admin.test.ts` (reuse the file's `connectClient`, `createAdminMockElement`, `wrapInIqResponse` helpers). Add this `completedUsersCommand` helper near the other helpers in the block, then the tests:

```ts
// Build a completed get-registered-users-list command with the given jids and
// an optional RSM <last> cursor (so fetchAllUsers knows whether to keep paging).
function completedUsersCommand(jids: string[], lastCursor?: string) {
  const children: any[] = [
    {
      name: 'x',
      attrs: { xmlns: 'jabber:x:data', type: 'result' },
      getChildren: (name: string) =>
        name === 'field'
          ? [{
              name: 'field',
              attrs: { var: 'registereduserjids' },
              getChild: () => undefined,
              getChildren: (n: string) =>
                n === 'value' ? jids.map((j) => ({ name: 'value', text: () => j })) : [],
            }]
          : [],
      getChild: () => undefined,
    },
  ]
  if (lastCursor !== undefined) {
    children.push({
      name: 'set',
      attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
      getChild: (n: string) =>
        n === 'last' ? { getText: () => lastCursor, attrs: {} } : undefined,
      getChildren: () => [],
    })
  }
  return createAdminMockElement(
    'command',
    { xmlns: 'http://jabber.org/protocol/commands', status: 'completed',
      node: 'http://jabber.org/protocol/admin#get-registered-users-list' },
    children
  )
}

it('fetchAllUsers accumulates across pages until no cursor remains', async () => {
  await connectClient()
  mockXmppClientInstance.iqCaller.request
    .mockResolvedValueOnce(wrapInIqResponse(completedUsersCommand(['a@x.com', 'b@x.com'], 'b@x.com')))
    .mockResolvedValueOnce(wrapInIqResponse(completedUsersCommand(['c@x.com'], undefined)))

  const result = await xmppClient.admin.fetchAllUsers()

  expect(result.users.map((u) => u.jid)).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
  expect(result.truncated).toBe(false)
})

it('fetchAllUsers caps at MAX_USERS and reports truncated', async () => {
  await connectClient()
  // A single page that already exceeds the cap (server ignored RSM max).
  const huge = Array.from({ length: MAX_USERS + 25 }, (_, i) => `u${i}@x.com`)
  mockXmppClientInstance.iqCaller.request
    .mockResolvedValue(wrapInIqResponse(completedUsersCommand(huge, 'cursor')))

  const result = await xmppClient.admin.fetchAllUsers()

  expect(result.users).toHaveLength(MAX_USERS)
  expect(result.truncated).toBe(true)
})
```

Add `MAX_USERS` to the existing top-of-file import from the Admin module:

```ts
import { MAX_USERS } from './Admin'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t fetchAllUsers`
Expected: FAIL (`fetchAllUsers` / `MAX_USERS` not defined).

- [ ] **Step 3: Implement `fetchAllUsers` + constants**

At the top of `Admin.ts`, just after the imports, add:

```ts
/** Hard cap on the full user-directory fetch. Past this, escalate to server-side search. */
export const MAX_USERS = 10000
/** RSM page size for the full user-directory fetch (large to minimize roundtrips). */
export const USER_PAGE_SIZE = 1500
```

Immediately after the `fetchUserList` method (before the `Room Management` banner, ~line 693), add:

```ts
  /**
   * Fetch the entire registered-user directory by looping {@link fetchUserList}
   * over RSM pages until complete or {@link MAX_USERS} is reached.
   *
   * @returns the accumulated users and whether the directory was truncated at the cap.
   */
  async fetchAllUsers(vhost?: string): Promise<{ users: AdminUser[]; truncated: boolean }> {
    const all: AdminUser[] = []
    let after: string | undefined
    let truncated = false
    // Guard against a server that ignores RSM and never advances the cursor.
    const maxPages = Math.ceil(MAX_USERS / USER_PAGE_SIZE) + 2

    for (let page = 0; page < maxPages; page++) {
      const { users, pagination } = await this.fetchUserList(vhost, {
        max: USER_PAGE_SIZE,
        ...(after ? { after } : {}),
      })
      all.push(...users)

      if (all.length >= MAX_USERS) {
        all.length = MAX_USERS
        truncated = true
        break
      }
      // Stop when the page is short or the server provides no next cursor.
      if (users.length < USER_PAGE_SIZE || !pagination.last) break
      after = pagination.last
    }

    return { users: all, truncated }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t fetchAllUsers`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Admin.ts packages/fluux-sdk/src/core/modules/Admin.test.ts
git commit -m "feat(sdk): add Admin.fetchAllUsers full-directory paged fetch with cap"
```

---

## Task 2: SDK `fetchOnlineUserJids` (bulk online snapshot)

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Admin.ts`
- Test: `packages/fluux-sdk/src/core/modules/Admin.test.ts`

**Interfaces:**
- Consumes: `getBareJid` from `../jid` (already importable; add to the existing `../jid` import line).
- Produces: `fetchOnlineUserJids(vhost?: string): Promise<Set<string>>` (bare JIDs; empty Set on any failure).

- [ ] **Step 1: Write the failing tests**

```ts
it('fetchOnlineUserJids returns a Set of bared online JIDs', async () => {
  await connectClient()
  const cmd = createAdminMockElement(
    'command',
    { xmlns: 'http://jabber.org/protocol/commands', status: 'completed',
      node: 'http://jabber.org/protocol/admin#get-online-users-list' },
    [{
      name: 'x',
      attrs: { xmlns: 'jabber:x:data', type: 'result' },
      getChildren: (name: string) =>
        name === 'field'
          ? [{
              name: 'field',
              attrs: { var: 'onlineuserjids' },
              getChild: () => undefined,
              getChildren: (n: string) =>
                n === 'value'
                  ? [
                      { name: 'value', text: () => 'alice@x.com/phone' },
                      { name: 'value', text: () => 'alice@x.com/desktop' },
                      { name: 'value', text: () => 'bob@x.com' },
                    ]
                  : [],
            }]
          : [],
      getChild: () => undefined,
    }]
  )
  mockXmppClientInstance.iqCaller.request.mockResolvedValue(wrapInIqResponse(cmd))

  const set = await xmppClient.admin.fetchOnlineUserJids()

  expect(set).toBeInstanceOf(Set)
  expect([...set].sort()).toEqual(['alice@x.com', 'bob@x.com'])
})

it('fetchOnlineUserJids returns an empty Set when the command fails', async () => {
  await connectClient()
  mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('forbidden'))

  const set = await xmppClient.admin.fetchOnlineUserJids()
  expect(set.size).toBe(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t fetchOnlineUserJids`
Expected: FAIL (`fetchOnlineUserJids` not defined).

- [ ] **Step 3: Implement `fetchOnlineUserJids`**

Ensure `getBareJid` is imported (edit the existing line 3 import):

```ts
import { getDomain, getLocalPart, getBareJid } from '../jid'
```

Add after `fetchAllUsers`:

```ts
  /**
   * Fetch the set of currently-online users (XEP-0133 get-online-users-list).
   * JIDs are bared so callers can match against bare JIDs in the user list.
   *
   * @returns a Set of bare JIDs, or an empty Set when the command is
   *   unavailable/unauthorised (so callers degrade to "no online info").
   */
  async fetchOnlineUserJids(vhost?: string): Promise<Set<string>> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return new Set()

    const node = `${NS_ADMIN}#get-online-users-list`
    const domain = vhost || getDomain(currentJid)

    try {
      const executeIq = xml(
        'iq',
        { type: 'set', to: domain, id: `online_${generateUUID()}` },
        xml('command', { xmlns: NS_COMMANDS, node, action: 'execute' })
      )
      const executeResult = await this.deps.sendIQ(executeIq)
      let command = executeResult.getChild('command', NS_COMMANDS)
      if (!command) return new Set()

      if (command.attrs.status === 'executing') {
        const sessionId = command.attrs.sessionid
        const completeIq = xml(
          'iq',
          { type: 'set', to: domain, id: `online_${generateUUID()}` },
          xml('command', { xmlns: NS_COMMANDS, node, action: 'complete', sessionid: sessionId },
            xml('x', { xmlns: NS_DATA_FORMS, type: 'submit' })
          )
        )
        const completeResult = await this.deps.sendIQ(completeIq)
        command = completeResult.getChild('command', NS_COMMANDS)
        if (!command) return new Set()
      }

      const formEl = command.getChild('x', NS_DATA_FORMS)
      if (!formEl) return new Set()
      const form = parseDataForm(formEl)
      let jids = getFormFieldValues(form, 'onlineuserjids')
      if (jids.length === 0) jids = getFormFieldValues(form, 'accountjids')
      if (jids.length === 0) jids = getFormFieldValues(form, 'userjids')

      return new Set(jids.filter(Boolean).map((j) => getBareJid(j)))
    } catch {
      return new Set()
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t fetchOnlineUserJids`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Admin.ts packages/fluux-sdk/src/core/modules/Admin.test.ts
git commit -m "feat(sdk): add Admin.fetchOnlineUserJids bulk online snapshot"
```

---

## Task 3: SDK `fetchLastActivity` + `LastActivityResult` type

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/admin.ts`
- Modify: `packages/fluux-sdk/src/index.ts` (export the type)
- Modify: `packages/fluux-sdk/src/core/modules/Admin.ts`
- Test: `packages/fluux-sdk/src/core/modules/Admin.test.ts`

**Interfaces:**
- Produces: `interface LastActivityResult { seconds: number | null; unsupported: boolean }`; `fetchLastActivity(jid: string): Promise<LastActivityResult>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('fetchLastActivity parses seconds on success', async () => {
  await connectClient()
  mockXmppClientInstance.iqCaller.request.mockResolvedValue({
    name: 'iq',
    attrs: { type: 'result' },
    getChild: (n: string, xmlns?: string) =>
      n === 'query' && xmlns === 'jabber:iq:last'
        ? { attrs: { seconds: '3600' } }
        : undefined,
  })

  const res = await xmppClient.admin.fetchLastActivity('bob@x.com')
  expect(res).toEqual({ seconds: 3600, unsupported: false })
})

it('fetchLastActivity reports unsupported on feature-not-implemented', async () => {
  await connectClient()
  const err: any = new Error('not implemented')
  err.condition = 'feature-not-implemented'
  mockXmppClientInstance.iqCaller.request.mockRejectedValue(err)

  const res = await xmppClient.admin.fetchLastActivity('bob@x.com')
  expect(res).toEqual({ seconds: null, unsupported: true })
})

it('fetchLastActivity returns per-user null on other errors', async () => {
  await connectClient()
  const err: any = new Error('item not found')
  err.condition = 'item-not-found'
  mockXmppClientInstance.iqCaller.request.mockRejectedValue(err)

  const res = await xmppClient.admin.fetchLastActivity('ghost@x.com')
  expect(res).toEqual({ seconds: null, unsupported: false })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t fetchLastActivity`
Expected: FAIL (`fetchLastActivity` not defined).

- [ ] **Step 3: Add the type, export it, implement the method**

In `core/types/admin.ts`, after the `AdminUser` interface, add:

```ts
/**
 * Result of an XEP-0012 last-activity query against an arbitrary account.
 * Discriminates a server-wide feature absence from a per-user null.
 *
 * @category Admin
 */
export interface LastActivityResult {
  /** Seconds since the user last logged out; null = unknown for this user. */
  seconds: number | null
  /** True only when the server returns feature-not-implemented (no mod_last). */
  unsupported: boolean
}
```

In `index.ts`, add `LastActivityResult` to the admin entity-list type export block (after `ServerStats,`):

```ts
  ServerStats,
  LastActivityResult,
```

In `Admin.ts`, ensure `NS_LAST` is imported (extend the existing namespaces import block that already lists `NS_ADMIN` etc.):

```ts
  NS_LAST,
```

Add the type to the existing `import type { ... } from '../types'` block in `Admin.ts`:

```ts
  LastActivityResult,
```

Implement after `fetchOnlineUserJids`:

```ts
  /**
   * Query last activity (XEP-0012 jabber:iq:last) for an arbitrary bare JID.
   * Roster-independent (unlike the roster-coupled LastActivity module), so it
   * works for any account in the admin directory.
   */
  async fetchLastActivity(jid: string): Promise<LastActivityResult> {
    const bare = getBareJid(jid)
    try {
      const iq = xml('iq', { type: 'get', to: bare, id: `last_${generateUUID()}` },
        xml('query', { xmlns: NS_LAST })
      )
      const result = await this.deps.sendIQ(iq)
      const query = result.getChild('query', NS_LAST)
      const secondsStr = query?.attrs?.seconds
      if (secondsStr === undefined) return { seconds: null, unsupported: false }
      const seconds = parseInt(secondsStr, 10)
      if (Number.isNaN(seconds)) return { seconds: null, unsupported: false }
      return { seconds, unsupported: false }
    } catch (err) {
      const condition = (err as { condition?: string })?.condition
      return { seconds: null, unsupported: condition === 'feature-not-implemented' }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t fetchLastActivity`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Admin.ts packages/fluux-sdk/src/core/types/admin.ts packages/fluux-sdk/src/index.ts packages/fluux-sdk/src/core/modules/Admin.test.ts
git commit -m "feat(sdk): add Admin.fetchLastActivity with feature-not-implemented discrimination"
```

---

## Task 4: SDK `LastActivityQueue` (bounded concurrency)

**Files:**
- Create: `packages/fluux-sdk/src/core/admin/lastActivityQueue.ts`
- Test: `packages/fluux-sdk/src/core/admin/lastActivityQueue.test.ts`

**Interfaces:**
- Consumes: `LastActivityResult` from `../types/admin`.
- Produces: `class LastActivityQueue` with `enqueue(jid: string): void` and `stop(): void`; constructor `(cb: { fetch: (jid: string) => Promise<LastActivityResult>; onResult: (jid: string, seconds: number | null) => void; onUnsupported: () => void }, concurrency?: number)`. Constant `LAST_ACTIVITY_CONCURRENCY = 6`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { LastActivityQueue } from './lastActivityQueue'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('LastActivityQueue', () => {
  it('dedupes repeated jids', () => {
    const fetch = vi.fn().mockResolvedValue({ seconds: 1, unsupported: false })
    const q = new LastActivityQueue({ fetch, onResult: vi.fn(), onUnsupported: vi.fn() }, 6)
    q.enqueue('a@x.com')
    q.enqueue('a@x.com')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never exceeds the concurrency cap', () => {
    const fetch = vi.fn(() => deferred<any>().promise)
    const q = new LastActivityQueue({ fetch, onResult: vi.fn(), onUnsupported: vi.fn() }, 6)
    for (let i = 0; i < 20; i++) q.enqueue(`u${i}@x.com`)
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('drains the backlog as in-flight requests resolve', async () => {
    const defs = Array.from({ length: 8 }, () => deferred<any>())
    let i = 0
    const fetch = vi.fn(() => defs[i++].promise)
    const onResult = vi.fn()
    const q = new LastActivityQueue({ fetch, onResult, onUnsupported: vi.fn() }, 2)
    for (let n = 0; n < 8; n++) q.enqueue(`u${n}@x.com`)
    expect(fetch).toHaveBeenCalledTimes(2)
    defs[0].resolve({ seconds: 5, unsupported: false })
    defs[1].resolve({ seconds: 5, unsupported: false })
    await Promise.resolve(); await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('stops everything on an unsupported result', async () => {
    const first = deferred<any>()
    const fetch = vi.fn().mockReturnValueOnce(first.promise)
      .mockResolvedValue({ seconds: 1, unsupported: false })
    const onUnsupported = vi.fn()
    const onResult = vi.fn()
    const q = new LastActivityQueue({ fetch, onResult, onUnsupported }, 1)
    q.enqueue('a@x.com')
    q.enqueue('b@x.com') // queued behind the cap of 1
    first.resolve({ seconds: null, unsupported: true })
    await Promise.resolve(); await Promise.resolve()
    expect(onUnsupported).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1) // b was dropped, never fetched
    q.enqueue('c@x.com') // ignored after stop
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports per-user null on a rejected fetch', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('boom'))
    const onResult = vi.fn()
    const q = new LastActivityQueue({ fetch, onResult, onUnsupported: vi.fn() }, 6)
    q.enqueue('a@x.com')
    await Promise.resolve(); await Promise.resolve()
    expect(onResult).toHaveBeenCalledWith('a@x.com', null)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/admin/lastActivityQueue.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the queue**

Create `packages/fluux-sdk/src/core/admin/lastActivityQueue.ts`:

```ts
import type { LastActivityResult } from '../types/admin'

/** Default number of last-activity queries allowed in flight at once. */
export const LAST_ACTIVITY_CONCURRENCY = 6

export interface LastActivityQueueCallbacks {
  /** Perform the actual query for a bare JID. */
  fetch: (jid: string) => Promise<LastActivityResult>
  /** Called with the resolved seconds (or null when unknown for this user). */
  onResult: (jid: string, seconds: number | null) => void
  /** Called once when the server reports the feature is unsupported. */
  onUnsupported: () => void
}

/**
 * Bounded-concurrency queue for lazy per-row last-activity queries.
 * Dedupes by JID, caps in-flight requests, and stops permanently once the
 * server reports the feature is unsupported (so we never flood a server
 * without mod_last).
 */
export class LastActivityQueue {
  private readonly queue: string[] = []
  private readonly seen = new Set<string>()
  private active = 0
  private stopped = false

  constructor(
    private readonly cb: LastActivityQueueCallbacks,
    private readonly concurrency: number = LAST_ACTIVITY_CONCURRENCY
  ) {}

  enqueue(jid: string): void {
    if (this.stopped || this.seen.has(jid)) return
    this.seen.add(jid)
    this.queue.push(jid)
    this.pump()
  }

  stop(): void {
    this.stopped = true
    this.queue.length = 0
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.queue.length > 0) {
      const jid = this.queue.shift() as string
      this.active++
      this.cb
        .fetch(jid)
        .then((res) => {
          if (res.unsupported) {
            this.stop()
            this.cb.onUnsupported()
          } else {
            this.cb.onResult(jid, res.seconds)
          }
        })
        .catch(() => this.cb.onResult(jid, null))
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/admin/lastActivityQueue.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/admin/lastActivityQueue.ts packages/fluux-sdk/src/core/admin/lastActivityQueue.test.ts
git commit -m "feat(sdk): add LastActivityQueue bounded-concurrency lazy fetcher"
```

---

## Task 5: SDK admin store state (online JIDs + last-activity map)

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/admin.ts` (add `LastActivityEntry`)
- Modify: `packages/fluux-sdk/src/index.ts` (export `LastActivityEntry`)
- Modify: `packages/fluux-sdk/src/stores/adminStore.ts`
- Test: `packages/fluux-sdk/src/stores/adminStore.test.ts`

**Interfaces:**
- Produces (store): state `onlineJids: Set<string>`, `lastActivity: Map<string, LastActivityEntry>`, `lastActivitySupported: boolean`, `usersTruncated: boolean`; actions `setOnlineJids(set)`, `setLastActivity(jid, entry)`, `setLastActivitySupported(bool)`, `setUsersTruncated(bool)`. `interface LastActivityEntry { state: 'loading' | 'loaded'; seconds: number | null }`.

- [ ] **Step 1: Write the failing tests**

Add to `adminStore.test.ts` (follow its existing import of `adminStore`):

```ts
describe('admin user-list extras', () => {
  beforeEach(() => adminStore.getState().reset())

  it('setLastActivity replaces the map reference (per-key subscribers re-render)', () => {
    const before = adminStore.getState().lastActivity
    adminStore.getState().setLastActivity('a@x.com', { state: 'loading', seconds: null })
    const after = adminStore.getState().lastActivity
    expect(after).not.toBe(before)
    expect(after.get('a@x.com')).toEqual({ state: 'loading', seconds: null })
  })

  it('setOnlineJids / setLastActivitySupported / setUsersTruncated store values', () => {
    adminStore.getState().setOnlineJids(new Set(['a@x.com']))
    adminStore.getState().setLastActivitySupported(false)
    adminStore.getState().setUsersTruncated(true)
    const s = adminStore.getState()
    expect(s.onlineJids.has('a@x.com')).toBe(true)
    expect(s.lastActivitySupported).toBe(false)
    expect(s.usersTruncated).toBe(true)
  })

  it('reset restores last-activity defaults', () => {
    adminStore.getState().setLastActivity('a@x.com', { state: 'loaded', seconds: 1 })
    adminStore.getState().setLastActivitySupported(false)
    adminStore.getState().setUsersTruncated(true)
    adminStore.getState().reset()
    const s = adminStore.getState()
    expect(s.lastActivity.size).toBe(0)
    expect(s.onlineJids.size).toBe(0)
    expect(s.lastActivitySupported).toBe(true)
    expect(s.usersTruncated).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/adminStore.test.ts -t "user-list extras"`
Expected: FAIL (actions/state not defined).

- [ ] **Step 3: Add the type, export it, extend the store**

In `core/types/admin.ts`, after `LastActivityResult`, add:

```ts
/**
 * Lazy per-JID last-activity cell held in the admin store for the user list.
 *
 * @category Admin
 */
export interface LastActivityEntry {
  /** 'loading' while in flight; 'loaded' once resolved (seconds may still be null). */
  state: 'loading' | 'loaded'
  /** Seconds since last logout; null = unknown/unavailable. */
  seconds: number | null
}
```

In `index.ts`, add to the admin type export block:

```ts
  LastActivityEntry,
```

In `stores/adminStore.ts`:

Extend the type import (line 2-11 block) to include `LastActivityEntry`:

```ts
  LastActivityEntry,
```

Add to the `AdminState` interface (after `roomList`/`mucServiceJid` region):

```ts
  // User-list extras (online snapshot + lazy last-activity)
  onlineJids: Set<string>
  lastActivity: Map<string, LastActivityEntry>
  lastActivitySupported: boolean
  usersTruncated: boolean
```

Add to the `AdminState` actions section:

```ts
  setOnlineJids: (jids: Set<string>) => void
  setLastActivity: (jid: string, entry: LastActivityEntry) => void
  setLastActivitySupported: (supported: boolean) => void
  setUsersTruncated: (truncated: boolean) => void
```

Add to `initialState`:

```ts
  onlineJids: new Set<string>(),
  lastActivity: new Map<string, LastActivityEntry>(),
  lastActivitySupported: true,
  usersTruncated: false,
```

Add the action implementations in the store body (near the other entity-list actions):

```ts
  setOnlineJids: (jids) => set({ onlineJids: jids }),

  setLastActivity: (jid, entry) => set((state) => {
    const next = new Map(state.lastActivity)
    next.set(jid, entry)
    return { lastActivity: next }
  }),

  setLastActivitySupported: (supported) => set({ lastActivitySupported: supported }),

  setUsersTruncated: (truncated) => set({ usersTruncated: truncated }),
```

Note: `initialState` is reused by `reset()`. Because `reset: () => set(initialState)` reuses the same `initialState` object, change the `onlineJids`/`lastActivity` initializers to fresh instances on reset by making `reset` clear them explicitly. Update `reset`:

```ts
  reset: () => set({
    ...initialState,
    onlineJids: new Set<string>(),
    lastActivity: new Map<string, LastActivityEntry>(),
  }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/adminStore.test.ts`
Expected: PASS (new block + existing tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/adminStore.ts packages/fluux-sdk/src/core/types/admin.ts packages/fluux-sdk/src/index.ts packages/fluux-sdk/src/stores/adminStore.test.ts
git commit -m "feat(sdk): add admin store online-jids + lazy last-activity state"
```

---

## Task 6: SDK `useAdmin` wiring (full fetch, online stamping, requestLastActivity)

**Files:**
- Modify: `packages/fluux-sdk/src/hooks/useAdmin.ts`

**Interfaces:**
- Consumes: `client.admin.fetchAllUsers`, `client.admin.fetchOnlineUserJids`, `client.admin.fetchLastActivity` (Tasks 1-3); `LastActivityQueue` (Task 4); store actions (Task 5); existing `hasCommand`.
- Produces (added to the hook's `actions` object and return value): `fetchAllUsers(): Promise<void>`, `requestLastActivity(jid: string): void`.

> No isolated unit test: `useAdmin` requires the XMPPProvider context, and all branching logic it composes is already covered by Tasks 1-5 (`LastActivityQueue`, store, SDK methods). This task is gated by SDK typecheck (Task 7) and exercised by the app tests in Tasks 10-11.

- [ ] **Step 1: Add imports and the queue ref**

At the top of `useAdmin.ts`, add imports:

```ts
import { useRef } from 'react'
import { LastActivityQueue } from '../core/admin/lastActivityQueue'
```

(Extend the existing `react` import rather than duplicating if `useRef` is not already imported.)

Inside the `useAdmin` function body, before the `actions` memo, add the queue ref (lazily constructed so it survives re-renders):

```ts
  const lastActivityQueueRef = useRef<LastActivityQueue | null>(null)
```

- [ ] **Step 2: Add `fetchAllUsers` action**

Add near `fetchUsers` (do not delete `fetchUsers`; `handleAddUserSubmit` still calls it for post-add refresh, and rooms reuse the pattern):

```ts
  // Fetch the entire user directory, then stamp a point-in-time online snapshot.
  const fetchAllUsers = useCallback(async () => {
    const store = adminStore.getState()
    store.setUserList({ isLoading: true, error: null })
    try {
      const vhost = store.selectedVhost || undefined
      const { users, truncated } = await client.admin.fetchAllUsers(vhost)

      // Online snapshot (only when the command is advertised). When unavailable,
      // leave isOnline undefined so the row hides the dot rather than showing gray.
      let stamped = users
      if (hasCommand('get-online-users-list')) {
        const online = await client.admin.fetchOnlineUserJids(vhost)
        adminStore.getState().setOnlineJids(online)
        stamped = users.map((u) => ({ ...u, isOnline: online.has(u.jid) }))
      } else {
        adminStore.getState().setOnlineJids(new Set())
      }

      adminStore.getState().setUserList({
        items: stamped,
        pagination: {},
        isLoading: false,
        hasFetched: true,
      })
      adminStore.getState().setUsersTruncated(truncated)
    } catch (error) {
      adminStore.getState().setUserList({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch users',
        hasFetched: true,
      })
      throw error
    }
  }, [client, hasCommand])
```

- [ ] **Step 3: Add `requestLastActivity` action**

```ts
  // Lazily fetch a single user's last activity, behind a bounded queue.
  const requestLastActivity = useCallback((jid: string) => {
    const store = adminStore.getState()
    if (!store.lastActivitySupported) return
    if (store.onlineJids.has(jid)) return        // online overrides last-login
    if (store.lastActivity.has(jid)) return       // already loading/loaded

    if (!lastActivityQueueRef.current) {
      lastActivityQueueRef.current = new LastActivityQueue({
        fetch: (j) => client.admin.fetchLastActivity(j),
        onResult: (j, seconds) =>
          adminStore.getState().setLastActivity(j, { state: 'loaded', seconds }),
        onUnsupported: () => adminStore.getState().setLastActivitySupported(false),
      })
    }

    store.setLastActivity(jid, { state: 'loading', seconds: null })
    lastActivityQueueRef.current.enqueue(jid)
  }, [client])
```

- [ ] **Step 4: Wire into the `actions` memo and return value**

Add `fetchAllUsers` and `requestLastActivity` to both the `actions` object literal AND its dependency array (mirror how `fetchUsers`/`searchUsers` appear in both):

```ts
      fetchUsers,
      fetchAllUsers,
      loadMoreUsers,
      searchUsers,
      requestLastActivity,
```

(Apply to the object and to the `[...]` deps array. The hook returns `...actions` already, so no further return change is needed; confirm by reading the final `return useMemo` block.)

- [ ] **Step 5: Repoint `searchUsers` (remove the misleading server-side claim)**

Replace the body of the existing `searchUsers` so it only records the query for the now-complete client-side filter (no network refetch):

```ts
  // Search is fully client-side over the cached full set (see AdminView filter).
  const searchUsers = useCallback((query: string) => {
    adminStore.getState().setUserList({ searchQuery: query })
  }, [])
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Run the full SDK test suite**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: PASS (no regressions).

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/hooks/useAdmin.ts
git commit -m "feat(sdk): wire useAdmin full-fetch, online stamping, lazy last-activity"
```

---

## Task 7: Build SDK and sync dist to main repo

**Files:** none (build artifacts only).

> The app (in this worktree) resolves `@fluux/sdk` to the MAIN repo's `dist`. The new exports (`fetchAllUsers`, `requestLastActivity`, `LastActivityResult`, `LastActivityEntry`, store fields) must be present in that dist before app typecheck/tests in Tasks 8-11.

- [ ] **Step 1: Build the SDK**

Run: `npm run build:sdk`
Expected: tsup build succeeds, dts emitted, no errors.

- [ ] **Step 2: Sync the built dist to the main repo**

Run: `cp -R packages/fluux-sdk/dist/* /Users/mremond/AIProjects/fluux-messenger/packages/fluux-sdk/dist/`
Expected: no error.

- [ ] **Step 3: Verify the app resolves the new exports**

Run: `npx tsc --noEmit -p apps/fluux/tsconfig.json`
Expected: any failures are about app code not yet written (Tasks 8-11), NOT "has no exported member 'fetchAllUsers'/'LastActivityResult'". If the latter appears, re-run Steps 1-2.

(No commit; build artifacts are git-ignored.)

---

## Task 8: App `formatRelativeTime` formatter

**Files:**
- Modify: `apps/fluux/src/utils/format.ts`
- Test: `apps/fluux/src/utils/format.test.ts`

**Interfaces:**
- Produces: `interface RelativeTimeLabels { justNow: string; minute: string; hour: string; day: string; week: string; month: string; year: string }`; `formatRelativeTime(secondsAgo: number, labels: RelativeTimeLabels): string`.

- [ ] **Step 1: Write the failing tests**

Append to `format.test.ts`:

```ts
import { formatRelativeTime } from './format'

const L = { justNow: 'just now', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' }

describe('formatRelativeTime', () => {
  it('returns just-now under a minute', () => {
    expect(formatRelativeTime(0, L)).toBe('just now')
    expect(formatRelativeTime(59, L)).toBe('just now')
  })
  it('picks a single coarse unit per bucket', () => {
    expect(formatRelativeTime(60, L)).toBe('1m ago')
    expect(formatRelativeTime(3600, L)).toBe('1h ago')
    expect(formatRelativeTime(2 * 86400, L)).toBe('2d ago')
    expect(formatRelativeTime(14 * 86400, L)).toBe('2w ago')
    expect(formatRelativeTime(60 * 86400, L)).toBe('2mo ago')
    expect(formatRelativeTime(400 * 86400, L)).toBe('1y ago')
  })
  it('clamps negatives to just-now', () => {
    expect(formatRelativeTime(-5, L)).toBe('just now')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/format.test.ts -t formatRelativeTime`
Expected: FAIL (`formatRelativeTime` not exported).

- [ ] **Step 3: Implement the formatter**

Append to `format.ts`:

```ts
export interface RelativeTimeLabels {
  justNow: string
  minute: string
  hour: string
  day: string
  week: string
  month: string
  year: string
}

/**
 * Seconds-ago to a friendly single-unit relative string ("just now", "5m ago",
 * "2d ago"). Pure: the caller passes localized unit labels. The "{n}{unit} ago"
 * shape is intentionally compact for admin scanning, not precise.
 */
export function formatRelativeTime(secondsAgo: number, labels: RelativeTimeLabels): string {
  const s = Math.floor(secondsAgo)
  if (s < 60) return labels.justNow
  const minute = 60, hour = 3600, day = 86400, week = 604800, month = 2592000, year = 31536000
  const pick = (value: number, unit: string) => `${value}${unit} ago`
  if (s < hour) return pick(Math.floor(s / minute), labels.minute)
  if (s < day) return pick(Math.floor(s / hour), labels.hour)
  if (s < week) return pick(Math.floor(s / day), labels.day)
  if (s < month) return pick(Math.floor(s / week), labels.week)
  if (s < year) return pick(Math.floor(s / month), labels.month)
  return pick(Math.floor(s / year), labels.year)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/format.ts apps/fluux/src/utils/format.test.ts
git commit -m "feat(app): add formatRelativeTime to the friendly formatter kit"
```

---

## Task 9: App `useWindowedList` hook (incremental client-side window)

**Files:**
- Create: `apps/fluux/src/hooks/useWindowedList.ts`
- Test: `apps/fluux/src/hooks/useWindowedList.test.ts`

**Interfaces:**
- Produces: `useWindowedList<T>(items: T[], opts?: { initial?: number; step?: number; resetKey?: string }): { visible: T[]; hasMore: boolean; loadMore: () => void }`. The window resets to `initial` whenever `resetKey` or the item-count identity changes.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/hooks/useWindowedList.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWindowedList } from './useWindowedList'

const items = Array.from({ length: 100 }, (_, i) => i)

describe('useWindowedList', () => {
  it('shows the initial window and reports hasMore', () => {
    const { result } = renderHook(() => useWindowedList(items, { initial: 20, step: 20 }))
    expect(result.current.visible).toHaveLength(20)
    expect(result.current.hasMore).toBe(true)
  })

  it('grows by step on loadMore and stops at the end', () => {
    const { result } = renderHook(() => useWindowedList(items, { initial: 20, step: 20 }))
    act(() => result.current.loadMore())
    expect(result.current.visible).toHaveLength(40)
    for (let i = 0; i < 10; i++) act(() => result.current.loadMore())
    expect(result.current.visible).toHaveLength(100)
    expect(result.current.hasMore).toBe(false)
  })

  it('resets the window when resetKey changes', () => {
    const { result, rerender } = renderHook(
      ({ key }) => useWindowedList(items, { initial: 20, step: 20, resetKey: key }),
      { initialProps: { key: 'a' } }
    )
    act(() => result.current.loadMore())
    expect(result.current.visible).toHaveLength(40)
    rerender({ key: 'b' })
    expect(result.current.visible).toHaveLength(20)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useWindowedList.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the hook**

Create `apps/fluux/src/hooks/useWindowedList.ts`:

```ts
import { useMemo, useState, useEffect } from 'react'

interface WindowedListOptions {
  initial?: number
  step?: number
  /** Changing this (e.g. the search query or vhost) resets the window. */
  resetKey?: string
}

/**
 * Render a large in-memory list incrementally so the DOM stays bounded.
 * Returns a growing slice plus a loadMore() to advance it. The window resets
 * to `initial` whenever `resetKey` or the list length changes.
 */
export function useWindowedList<T>(items: T[], opts: WindowedListOptions = {}) {
  const initial = opts.initial ?? 50
  const step = opts.step ?? 50
  const [count, setCount] = useState(initial)

  // Reset when the filter key or the underlying list size changes.
  useEffect(() => {
    setCount(initial)
  }, [opts.resetKey, items.length, initial])

  const visible = useMemo(() => items.slice(0, count), [items, count])
  const hasMore = count < items.length
  const loadMore = () => setCount((c) => Math.min(c + step, items.length))

  return { visible, hasMore, loadMore }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useWindowedList.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/useWindowedList.ts apps/fluux/src/hooks/useWindowedList.test.ts
git commit -m "feat(app): add useWindowedList for bounded incremental rendering"
```

---

## Task 10: App `UserListItem` row (presence dot + lazy last-login)

**Files:**
- Modify: `apps/fluux/src/components/UserListItem.tsx`
- Modify: `apps/fluux/src/test-setup.ts` (extend the `@fluux/sdk` mock)
- Test: `apps/fluux/src/components/UserListItem.test.tsx` (create)

**Interfaces:**
- Consumes: `useAdminStore` from `@fluux/sdk` (per-key selectors only); `formatRelativeTime` (Task 8); `LastActivityEntry` type. `requestLastActivity` arrives as a PROP (not via `useAdmin()` in the row, which would subscribe every row to the full `userList` and defeat the list-item subscription rule).
- Produces: an enhanced `UserListItem` with props `{ user: AdminUser; onSelect: (user: AdminUser) => void; requestLastActivity: (jid: string) => void }`.

- [ ] **Step 1: Extend the app test-setup mock**

In `apps/fluux/src/test-setup.ts`, update the `useAdminStore` mock state (around line 396) to include the new fields and a per-key-capable `lastActivity` map:

```ts
  useAdminStore: vi.fn((selector) => {
    const state = {
      mucServiceJid: null,
      setActiveCategory: vi.fn(),
      onlineJids: new Set<string>(),
      lastActivity: new Map(),
      lastActivitySupported: true,
      usersTruncated: false,
    }
    return selector ? selector(state) : state
  }),
```

Also ensure the `useAdmin` mock (used by `AdminView`, Task 11) exposes the new actions/state. Find the `useAdmin: vi.fn(() => ({ ... }))` block in `test-setup.ts` and add:

```ts
    requestLastActivity: vi.fn(),
    fetchAllUsers: vi.fn(),
    usersTruncated: false,
```

(If `useAdmin` is not yet present in the mock, add a minimal entry alongside the other hook mocks: `useAdmin: vi.fn(() => ({ requestLastActivity: vi.fn(), fetchAllUsers: vi.fn(), usersTruncated: false }))`. The row itself does NOT call `useAdmin`; `requestLastActivity` reaches it as a prop.)

- [ ] **Step 2: Write the failing tests**

Create `apps/fluux/src/components/UserListItem.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useAdminStore } from '@fluux/sdk'
import { UserListItem } from './UserListItem'

function setAdminState(partial: Record<string, unknown>) {
  ;(useAdminStore as unknown as { mockImplementation: Function }).mockImplementation(
    (selector?: (s: any) => unknown) => {
      const state = {
        onlineJids: new Set<string>(),
        lastActivity: new Map(),
        lastActivitySupported: true,
        ...partial,
      }
      return selector ? selector(state) : state
    }
  )
}

describe('UserListItem', () => {
  it('shows "online now" and an online dot for online users', () => {
    setAdminState({})
    render(<UserListItem user={{ jid: 'a@x.com', username: 'a', isOnline: true }} onSelect={vi.fn()} requestLastActivity={vi.fn()} />)
    expect(screen.getByText('admin.users.onlineNow')).toBeInTheDocument()
    expect(screen.getByLabelText('admin.users.online')).toBeInTheDocument()
  })

  it('renders a relative time when last activity is loaded', () => {
    setAdminState({ lastActivity: new Map([['a@x.com', { state: 'loaded', seconds: 7200 }]]) })
    render(<UserListItem user={{ jid: 'a@x.com', username: 'a', isOnline: false }} onSelect={vi.fn()} requestLastActivity={vi.fn()} />)
    expect(screen.getByText(/ago/)).toBeInTheDocument()
  })

  it('renders nothing in the cell when last activity is null', () => {
    setAdminState({ lastActivity: new Map([['a@x.com', { state: 'loaded', seconds: null }]]) })
    render(<UserListItem user={{ jid: 'a@x.com', username: 'a', isOnline: false }} onSelect={vi.fn()} requestLastActivity={vi.fn()} />)
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument()
  })

  it('hides the presence dot when online info is unavailable (isOnline undefined)', () => {
    setAdminState({})
    render(<UserListItem user={{ jid: 'a@x.com', username: 'a' }} onSelect={vi.fn()} requestLastActivity={vi.fn()} />)
    expect(screen.queryByLabelText('admin.users.online')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('admin.users.offline')).not.toBeInTheDocument()
  })
})
```

(The i18n mock in `test-setup.ts` returns the key string, so assertions match `admin.users.*` keys directly.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/UserListItem.test.tsx`
Expected: FAIL (current `UserListItem` renders only the JID).

- [ ] **Step 4: Implement the row**

Replace `apps/fluux/src/components/UserListItem.tsx`:

```tsx
import { useEffect, useRef, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAdminStore, type AdminUser, type LastActivityEntry } from '@fluux/sdk'
import { formatRelativeTime, formatDateTime, type RelativeTimeLabels } from '../utils/format'

interface UserListItemProps {
  user: AdminUser
  onSelect: (user: AdminUser) => void
  /** Passed down from AdminView (not via useAdmin here) to avoid per-row list subscriptions. */
  requestLastActivity: (jid: string) => void
}

function UserListItemImpl({ user, onSelect, requestLastActivity }: UserListItemProps) {
  const { t } = useTranslation()
  // Per-key subscriptions only (never the whole map): render-perf rule.
  const entry = useAdminStore((s) => s.lastActivity.get(user.jid)) as LastActivityEntry | undefined
  const supported = useAdminStore((s) => s.lastActivitySupported)
  const rowRef = useRef<HTMLButtonElement>(null)
  const requested = useRef(false)

  const isOnline = user.isOnline
  const showDot = isOnline !== undefined

  // Fire one lazy last-activity request when the row first becomes visible.
  useEffect(() => {
    if (isOnline === true || !supported || requested.current) return
    const el = rowRef.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !requested.current) {
        requested.current = true
        requestLastActivity(user.jid)
        observer.disconnect()
      }
    }, { threshold: 0.1 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [user.jid, isOnline, supported, requestLastActivity])

  const labels: RelativeTimeLabels = {
    justNow: t('admin.users.justNow'),
    minute: t('admin.users.unitMinute'),
    hour: t('admin.users.unitHour'),
    day: t('admin.users.unitDay'),
    week: t('admin.users.unitWeek'),
    month: t('admin.users.unitMonth'),
    year: t('admin.users.unitYear'),
  }

  const renderCell = () => {
    if (isOnline === true) {
      return <span className="text-xs text-green-600 dark:text-green-400">{t('admin.users.onlineNow')}</span>
    }
    if (!supported) return null
    if (!entry || entry.state === 'loading') {
      return <span className="inline-block h-3 w-12 rounded bg-fluux-hover animate-pulse" aria-hidden="true" />
    }
    if (entry.seconds == null) return null
    const absolute = formatDateTime(Date.now() - entry.seconds * 1000)
    return (
      <span className="text-xs text-fluux-muted" title={absolute}>
        {formatRelativeTime(entry.seconds, labels)}
      </span>
    )
  }

  return (
    <button
      ref={rowRef}
      onClick={() => onSelect(user)}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-fluux-hover
                 transition-colors text-start"
    >
      {showDot && (
        <span
          className={`size-2 rounded-full shrink-0 ${isOnline ? 'bg-green-500' : 'bg-fluux-muted'}`}
          aria-label={isOnline ? t('admin.users.online') : t('admin.users.offline')}
        />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fluux-text truncate">{user.jid}</p>
      </div>
      <div className="shrink-0">{renderCell()}</div>
    </button>
  )
}

export const UserListItem = memo(UserListItemImpl)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/UserListItem.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/UserListItem.tsx apps/fluux/src/components/UserListItem.test.tsx apps/fluux/src/test-setup.ts
git commit -m "feat(app): UserListItem presence dot + lazy last-login cell"
```

---

## Task 11: App `AdminView` wiring (full fetch, complete search, windowing, banner)

**Files:**
- Modify: `apps/fluux/src/components/AdminView.tsx`

**Interfaces:**
- Consumes: `fetchAllUsers`, `requestLastActivity`, `usersTruncated` from `useAdmin`/store (Tasks 5-6); `useWindowedList` (Task 9); existing `EntityListView`, `filteredUsers`, `userSearchQuery`, `selectedVhost`, `serverStats`.

> This task is integration wiring composed of already-tested units (full fetch, store, windowing, row). Verification is the app typecheck plus the full app test suite (the existing AdminView/ChatLayout tests must stay green); no new isolated test is added because the heavy logic lives in Tasks 4, 5, 9, 10.

- [ ] **Step 1: Switch the users-category entry to the full fetch**

Find where the users category currently triggers `fetchUsers` on entry (the effect / handler that loads users when `activeCategory === 'users'`). Replace that `fetchUsers()` call with `fetchAllUsers()`. Add `fetchAllUsers` and `requestLastActivity` to the existing destructure of `useAdmin()` at the top of `AdminView.tsx`:

```ts
  const { /* existing actions */ fetchAllUsers, requestLastActivity } = useAdmin()
```

Read `usersTruncated` via a direct store selector (the hook does NOT spread the full store into its return, so a selector is the correct, reactive way). Add the import and the selector near the other top-level hooks:

```ts
import { useAdminStore } from '@fluux/sdk'
// ...
  const usersTruncated = useAdminStore((s) => s.usersTruncated)
```

> Keep `fetchUsers` referenced by `handleAddUserSubmit` (post-add refresh) pointed at `fetchAllUsers` so a newly added user appears with online/last-login wiring:

```ts
  const handleAddUserSubmit = async (username: string, password: string) => {
    await addUser(username, password)
    setShowAddUserModal(false)
    resetUserList()
    void fetchAllUsers()
  }
```

- [ ] **Step 2: Window the filtered users**

After the `filteredUsers` computation (~line 252), add the windowing hook (reset on query OR vhost change):

```ts
  const usersWindow = useWindowedList(filteredUsers, {
    initial: 60,
    step: 60,
    resetKey: `${userSearchQuery}|${selectedVhost ?? ''}`,
  })
```

Add the import at the top:

```ts
import { useWindowedList } from '../hooks/useWindowedList'
```

- [ ] **Step 3: Feed the window into the users `EntityListView`**

In the `activeCategory === 'users'` branch, change the `EntityListView` props so it renders the window and grows locally (no network):

```tsx
          <EntityListView
            title={t('admin.userList.title')}
            items={usersWindow.visible}
            isLoading={userList.isLoading}
            hasMore={usersWindow.hasMore}
            searchValue={userSearchQuery}
            totalCount={serverStats?.registeredUsers}
            onSearchChange={setUserSearchQuery}
            onLoadMore={usersWindow.loadMore}
            emptyMessage={t('admin.userList.noUsers')}
            keyExtractor={(user) => user.jid}
            renderItem={(user) => (
              <UserListItem
                user={user}
                onSelect={handleSelectUser}
                requestLastActivity={requestLastActivity}
              />
            )}
            headerAction={/* keep the existing Add-User Tooltip+button JSX unchanged */}
          />
```

(Keep the existing `headerAction` JSX exactly as it is today. Leave the rooms-category `EntityListView` untouched: it keeps `hasMore={hasMoreRooms ...}` and `onLoadMore={loadMoreRooms}`.)

- [ ] **Step 4: Add the truncation banner**

Directly above the users `EntityListView` (inside the `activeCategory === 'users'` container `div`, after the vhost selector), add:

```tsx
          {usersTruncated && (
            <div className="mb-3 px-3 py-2 text-sm rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300">
              {t('admin.users.truncatedBanner', {
                shown: filteredUsers.length,
                total: serverStats?.registeredUsers ?? userList.items.length,
              })}
            </div>
          )}
```

- [ ] **Step 5: Remove the stale "client-side for now" comment**

Update the comment at ~line 246 to reflect that the filter now runs over the complete cached set:

```ts
  // Filter users by search query (complete: runs over the full fetched directory)
```

- [ ] **Step 6: Typecheck the app**

Run: `npx tsc --noEmit -p apps/fluux/tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Run the app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS (existing AdminView/ChatLayout tests green; new tests from Tasks 8-10 green).

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/AdminView.tsx
git commit -m "feat(app): AdminView full-fetch users, complete search, windowing, truncation banner"
```

---

## Task 12: i18n keys in all 33 locales

**Files:**
- Modify: every file in `apps/fluux/src/i18n/locales/*.json` (33 files)
- Test: `apps/fluux/src/i18n/i18n.test.ts` (existing parity test)

**Interfaces:**
- Produces: `admin.users.{onlineNow, online, offline, justNow, unitMinute, unitHour, unitDay, unitWeek, unitMonth, unitYear, truncatedBanner}` keys, present and translated in all 33 locales.

- [ ] **Step 1: Add English keys first (source of truth)**

In `apps/fluux/src/i18n/locales/en.json`, under the existing `admin` object, add a `users` block (place it near `userList`):

```json
"users": {
  "online": "Online",
  "offline": "Offline",
  "onlineNow": "Online now",
  "justNow": "just now",
  "unitMinute": "m",
  "unitHour": "h",
  "unitDay": "d",
  "unitWeek": "w",
  "unitMonth": "mo",
  "unitYear": "y",
  "truncatedBanner": "Showing the first {{shown}} of {{total}} users. Refine your search to narrow results."
}
```

- [ ] **Step 2: Run the parity test to verify it fails for the other 32 locales**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: FAIL (missing `admin.users.*` keys in the other locales).

- [ ] **Step 3: Translate the keys into all remaining 32 locales**

For each non-English locale file, add the same `admin.users` block with genuine translations of `online`, `offline`, `onlineNow`, `justNow`, and `truncatedBanner` (translate `{{shown}}`/`{{total}}` placeholders verbatim, keep them intact). Unit labels (`unitMinute`..`unitYear`) stay as the locale's conventional short forms (for many locales the Latin `m/h/d/w/mo/y` are acceptable; use locale-appropriate short forms where they exist, e.g. German `Min`/`Std`/`T`). Do NOT use any em-dash or en-dash in any value.

Translate, do not leave English placeholders (project i18n rule). Apply to: `ar, ca, cs, da, de, el, es, fi, fr, he, hi, hu, id, it, ja, ko, nl, no, pl, pt, pt-BR, ro, ru, sv, th, tr, uk, vi, zh, zh-TW` and any other locale files present (the directory listing in Step 0 below is authoritative).

Step 0 (run first to get the authoritative list):
Run: `ls apps/fluux/src/i18n/locales/`

- [ ] **Step 4: Scan new values for forbidden dashes**

Run: `grep -rn '[—–]' apps/fluux/src/i18n/locales/`
Expected: no lines referencing the new `admin.users.*` values. (Pre-existing matches in unrelated keys may appear; confirm none are in your new block.) If a new value contains a dash, replace it with `. `, `, `, or `: ` per the i18n style rule.

- [ ] **Step 5: Run the parity test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/i18n/locales
git commit -m "i18n(admin): add admin.users.* keys in all 33 locales"
```

---

## Final Verification

- [ ] **Step 1: Rebuild SDK + sync dist** (in case later SDK edits landed)

Run: `npm run build:sdk && cp -R packages/fluux-sdk/dist/* /Users/mremond/AIProjects/fluux-messenger/packages/fluux-sdk/dist/`
Expected: success.

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS, no stderr.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin mr/objective-maxwell-796837
gh pr create --title "feat(admin): usable user list (complete search, online status, last-login)" \
  --body "Makes the admin user list usable: full-directory fetch with cached complete client-side search, a point-in-time online/offline indicator per row, and a lazily-loaded last-login column. All capabilities are discovery-gated and degrade to today's plain list. Spec: docs/superpowers/specs/2026-06-22-admin-user-management-usable-list-design.md"
```

---

## Self-Review Notes (spec coverage)

- Spec A (3 SDK methods): Tasks 1, 2, 3.
- Spec B (types): `LastActivityResult` (Task 3), `LastActivityEntry` (Task 5).
- Spec C (store): Task 5.
- Spec D (hook full-fetch, online stamping, requestLastActivity queue, searchUsers honesty, constants): Tasks 4 (queue) + 6 (wiring).
- Spec E (complete search): Task 11 Step 5 (filter now over full set; the SDK fetch in Task 1 guarantees the full set).
- Spec F (windowing, opt-in, rooms untouched): Task 9 (hook) + Task 11 Steps 2-3.
- Spec G (row UI + formatRelativeTime): Tasks 8 + 10.
- Spec H (i18n, 33 locales): Task 12.
- Spec I (edge cases): truncation banner (Task 11 Step 4), vhost reset (Task 11 Step 2 resetKey + Task 6 fresh fetch + Task 5 reset), online overrides last-login (Task 6 guard + Task 10 cell), missing-command degrade / hide-dot (Task 6 isOnline-undefined + Task 10 showDot), fast-scroll dedupe/cap (Task 4).
- Spec J (testing): SDK Tasks 1-5; app Tasks 8-10; integration via suites in Tasks 6, 11, Final.
