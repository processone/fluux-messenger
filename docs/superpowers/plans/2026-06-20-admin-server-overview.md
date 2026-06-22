# Admin Server Overview + Friendly Kit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw admin "stats" category with a readable server-overview dashboard of vital signs, and extract the reusable value-formatting "friendly kit" that later admin functions build on.

**Architecture:** The SDK gains a typed `fetchServerStats()` (keeps all XMPP/stanza knowledge); it emits `admin:server-stats` which routes through the existing store-binding to `adminStore.serverStats`. The app renders a `<ServerOverview>` of discovery-driven cards from a declarative registry, using pure formatters in `utils/format.ts`. The existing raw command runner is preserved under an "Advanced" disclosure.

**Tech Stack:** TypeScript, Zustand vanilla stores, React 19, Vitest, react-i18next, ltx/@xmpp elements.

**Spec:** `docs/superpowers/specs/2026-06-20-admin-server-overview-design.md`

**Branch:** `feat/admin-server-overview` (already created, spec committed).

---

## File Structure

**SDK (`packages/fluux-sdk/`):**
- `src/core/namespaces.ts` — add `NS_VERSION`.
- `src/core/types/admin.ts` — add `ServerStats` interface.
- `src/core/types/sdk-events.ts` — add `admin:server-stats` event.
- `src/core/modules/Admin.ts` — add `fetchServerStats` + private `fetchUptimeSeconds`/`fetchServerVersion`; extend `executeApiCommand` with field overrides.
- `src/core/modules/Admin.test.ts` — tests for `fetchServerStats`.
- `src/stores/adminStore.ts` — add `serverStats`, `isLoadingStats` + setters.
- `src/core/types/client.ts` — add `setServerStats` to `StoreBindings.admin`.
- `src/core/defaultStoreBindings.ts` — wire `setServerStats`.
- `src/core/test-utils.ts` — add `setServerStats` to admin mock.
- `src/bindings/storeBindings.ts` — route `admin:server-stats` → store.
- `src/hooks/useAdmin.ts` — expose `serverStats`, `isLoadingStats`, `fetchServerStats`.
- `src/demo/DemoClient.ts` — seed admin discovery + stat/version responses (dev verification).

**App (`apps/fluux/`):**
- `src/utils/format.ts` (new) — pure formatters (the kit).
- `src/utils/format.test.ts` (new) — formatter tests.
- `src/components/admin/adminOverview.ts` (new) — card registry.
- `src/components/ServerOverview.tsx` (new) — overview component.
- `src/components/ServerOverview.test.tsx` (new) — render tests.
- `src/components/AdminView.tsx` — render `<ServerOverview>` for `stats` category.
- `src/components/AdminDashboard.tsx` — `stats` becomes a non-expanding category; badges read `serverStats`.
- `src/components/ChatLayout.tsx` — `adminHasMainContent` includes `stats`.
- `src/i18n/locales/*.json` (33 files) — `admin.overview.*` keys.
- `src/test-setup.ts` — add new `useAdmin` fields to the `@fluux/sdk` mock.

**Build note:** after any SDK type/exports change, run `npm run build:sdk` before app typecheck (per CLAUDE.md).

---

## Phase 1 — SDK: structured stats

### Task 1: Add `NS_VERSION` namespace

**Files:**
- Modify: `packages/fluux-sdk/src/core/namespaces.ts`

- [ ] **Step 1: Add the namespace constant**

Add near the other top-level namespace constants (after `NS_DISCO_ITEMS`):

```ts
export const NS_VERSION = 'jabber:iq:version'
```

- [ ] **Step 2: Commit**

```bash
git add packages/fluux-sdk/src/core/namespaces.ts
git commit -m "feat(sdk): add jabber:iq:version namespace"
```

---

### Task 2: Add `ServerStats` type

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/admin.ts`

- [ ] **Step 1: Add the interface** at the end of the "Admin Entity Types" section (after `EntityCounts`):

```ts
/**
 * Structured server vital-signs for the admin overview dashboard.
 *
 * Every metric is optional: a metric is omitted when the server does not
 * advertise / authorise the underlying command (discovery-driven).
 *
 * @category Admin
 */
export interface ServerStats {
  /** Server uptime in seconds (ejabberd `stats uptimeseconds`). */
  uptimeSeconds?: number
  /** Server software version, e.g. "ejabberd 26.01" (XEP-0092). */
  version?: string
  /** Total registered users (XEP-0133 get-registered-users-num). */
  registeredUsers?: number
  /** Currently online users (XEP-0133 get-online-users-num). */
  onlineUsers?: number
  /** Active MUC rooms across all vhosts (muc_online_rooms_count, service=global). */
  onlineRooms?: number
  /** Number of virtual hosts the admin can see. */
  vhostCount?: number
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number
}
```

- [ ] **Step 2: Verify `ServerStats` is re-exported.** `core/types/index.ts` re-exports `admin.ts`; confirm with:

Run: `grep -n "from './admin'" packages/fluux-sdk/src/core/types/index.ts`
Expected: a `export * from './admin'` (or explicit list). If the export is an explicit list, add `ServerStats` to it.

- [ ] **Step 3: Typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/fluux-sdk/src/core/types/admin.ts packages/fluux-sdk/src/core/types/index.ts
git commit -m "feat(sdk): add ServerStats type"
```

---

### Task 3: Add `admin:server-stats` event

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts`

- [ ] **Step 1: Add the event** inside `interface AdminEvents` (after `admin:entity-counts`):

```ts
  /** Server vital-signs snapshot updated */
  'admin:server-stats': {
    stats: ServerStats
  }
```

- [ ] **Step 2: Ensure `ServerStats` is imported** at the top of `sdk-events.ts`. Find the existing admin-type import (it already imports `AdminCommand`, `AdminSession`) and add `ServerStats`:

Run: `grep -n "AdminCommand" packages/fluux-sdk/src/core/types/sdk-events.ts | head -1`
Then add `ServerStats` to that import line's type list.

- [ ] **Step 3: Typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/fluux-sdk/src/core/types/sdk-events.ts
git commit -m "feat(sdk): add admin:server-stats event"
```

---

### Task 4: Store state + binding plumbing

**Files:**
- Modify: `packages/fluux-sdk/src/stores/adminStore.ts`
- Modify: `packages/fluux-sdk/src/core/types/client.ts:218` (admin `StoreBindings`)
- Modify: `packages/fluux-sdk/src/core/defaultStoreBindings.ts:237`
- Modify: `packages/fluux-sdk/src/core/test-utils.ts:747`
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts:551`

- [ ] **Step 1: adminStore — import the type.** In the type import block at the top, add `ServerStats`:

```ts
import type {
  AdminCommand,
  AdminSession,
  AdminUser,
  AdminRoom,
  EntityListState,
  EntityCounts,
  RSMResponse,
  AdminCategory,
  ServerStats,
} from '../core/types'
```

- [ ] **Step 2: adminStore — add state fields** to `interface AdminState` (after `mucServiceJid: string | null`):

```ts
  // Server overview vital-signs (new)
  serverStats: ServerStats | null
  isLoadingStats: boolean
```

- [ ] **Step 3: adminStore — add setter signatures** to `interface AdminState` (after `setMucServiceJid`):

```ts
  setServerStats: (stats: ServerStats | null) => void
  setIsLoadingStats: (loading: boolean) => void
```

- [ ] **Step 4: adminStore — add to `initialState`** (after `mucServiceJid: null as string | null,`):

```ts
  serverStats: null as ServerStats | null,
  isLoadingStats: false,
```

- [ ] **Step 5: adminStore — implement setters** in the store body (after `setMucServiceJid`):

```ts
  setServerStats: (stats) => set({ serverStats: stats }),
  setIsLoadingStats: (loading) => set({ isLoadingStats: loading }),
```

- [ ] **Step 6: client.ts — extend the admin `StoreBindings` interface.** After `setMucServiceJid: (jid: string | null) => void`:

```ts
    setServerStats: (stats: ServerStats | null) => void
```

Ensure `ServerStats` is imported in `client.ts` (add to the existing admin-types import).

- [ ] **Step 7: defaultStoreBindings.ts — wire the setter.** In the `admin:` block (after `setMucServiceJid: adminStore.getState().setMucServiceJid,`):

```ts
      setServerStats: adminStore.getState().setServerStats,
```

- [ ] **Step 8: test-utils.ts — add the mock.** In the admin mock object (after `setMucServiceJid: vi.fn(),`):

```ts
    setServerStats: vi.fn(),
```

- [ ] **Step 9: storeBindings.ts — route the event.** After the `on('admin:muc-service', …)` handler:

```ts
  on('admin:server-stats', ({ stats }) => {
    const stores = getStores()
    stores.admin.setServerStats(stats)
  })
```

- [ ] **Step 10: Typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add packages/fluux-sdk/src/stores/adminStore.ts packages/fluux-sdk/src/core/types/client.ts packages/fluux-sdk/src/core/defaultStoreBindings.ts packages/fluux-sdk/src/core/test-utils.ts packages/fluux-sdk/src/bindings/storeBindings.ts
git commit -m "feat(sdk): plumb serverStats through store and bindings"
```

---

### Task 5: `executeApiCommand` field overrides

The two-step api-commands (`stats`, `muc_online_rooms_count`) need to submit non-default field values (`name=uptimeseconds`, `service=global`). Extend the existing helper without breaking current callers.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Admin.ts` (the private `executeApiCommand`, ~line 391)
- Test: `packages/fluux-sdk/src/core/modules/Admin.test.ts`

- [ ] **Step 1: Write the failing test.** In `Admin.test.ts`, add a `describe('executeApiCommand overrides', …)` that drives it through `fetchServerStats` (the override is exercised in Task 6); for this task, assert the submit stanza carries the override. Mirror how neighbouring tests feed IQ responses via `mockXmppClientInstance`. Add:

```ts
it('submits overridden field values for two-step api-commands', async () => {
  // execute → returns a form requiring `name` (default registeredusers)
  const executing = createAdminMockElement('iq', { type: 'result' }, [
    createAdminMockElement('command', { xmlns: 'http://jabber.org/protocol/commands', node: 'api-commands/stats', status: 'executing', sessionid: 'sess-1' }, [
      createAdminMockElement('actions', {}, []),
      createAdminMockElement('x', { xmlns: 'jabber:x:data', type: 'form' }, [
        createAdminMockElement('field', { var: 'name', type: 'text-single' }, [
          createAdminMockElement('value', {}, []),
        ]),
      ]),
    ]),
  ])
  // complete → returns the stat value
  const completed = createAdminMockElement('iq', { type: 'result' }, [
    createAdminMockElement('command', { xmlns: 'http://jabber.org/protocol/commands', node: 'api-commands/stats', status: 'completed' }, [
      createAdminMockElement('x', { xmlns: 'jabber:x:data', type: 'result' }, [
        createAdminMockElement('field', { var: 'stat', type: 'text-single' }, [
          createAdminMockElement('value', {}, []),
        ]),
      ]),
    ]),
  ])
  // Feed responses in order; capture the second (complete) request.
  const sendIQ = vi.spyOn(xmppClient as any, 'sendIQ')
    .mockResolvedValueOnce(executing)
    .mockResolvedValueOnce(completed)

  await (xmppClient.admin as any).executeApiCommand('stats', { name: 'uptimeseconds' })

  const completeReq = sendIQ.mock.calls[1][0] as any
  const submittedName = completeReq.children?.[0]?.children?.find((c: any) => c.attrs?.var === 'name')
  expect(submittedName?.children?.[0]?.children?.[0]).toBe('uptimeseconds')
})
```

> NOTE: the exact element-traversal in the assertion depends on the `xml()` mock shape in `Admin.test.ts` (see its `vi.mock('@xmpp/client')` — `xml` returns `{name, attrs, children}`). Adapt the `.children` path to that shape; the existing `executeAdminCommand` tests show the working pattern for reading submitted fields. If `sendIQ` is not directly spy-able, feed responses the same way the existing `fetchUserList`/`fetchEntityCounts` tests do.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t "overridden field values"`
Expected: FAIL (override ignored — submits the default `registeredusers`).

- [ ] **Step 3: Implement the override.** Change the signature and the submit-field builder in `executeApiCommand`:

```ts
  private async executeApiCommand(
    commandName: string,
    overrides?: Record<string, string | string[]>
  ): Promise<DataForm | null> {
```

In the `status === 'executing' && formEl` branch, replace the `submitFields` builder with:

```ts
        const submitFields = form.fields
          .filter(field => field.var && field.type !== 'fixed')
          .map(field => {
            const overridden = overrides?.[field.var]
            const raw = overridden !== undefined ? overridden : field.value
            const values = Array.isArray(raw) ? raw : (raw ? [raw] : [])
            return xml('field', { var: field.var },
              ...values.map((v: string) => xml('value', {}, v))
            )
          })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t "overridden field values"`
Expected: PASS

- [ ] **Step 5: Run the full Admin suite to check for regressions** (existing `fetchEntityCounts` calls `executeApiCommand('muc_online_rooms_count')` with no overrides — must still pass)

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Admin.ts packages/fluux-sdk/src/core/modules/Admin.test.ts
git commit -m "feat(sdk): allow field overrides in executeApiCommand"
```

---

### Task 6: `fetchServerStats`

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Admin.ts`
- Test: `packages/fluux-sdk/src/core/modules/Admin.test.ts`

- [ ] **Step 1: Write the failing test.** Add `describe('fetchServerStats', …)` that feeds the six sub-fetches and asserts the structured result + the emitted event. Use the real response shapes confirmed from process-one.net:

```ts
describe('fetchServerStats', () => {
  it('aggregates vital signs into a structured object and emits admin:server-stats', async () => {
    // Order of sendIQ calls inside fetchServerStats:
    //  1) get-registered-users-num  -> registeredusersnum = 15
    //  2) get-online-users-num      -> onlineusersnum = 7
    //  3) muc_online_rooms_count    -> (two-step) count = 10
    //  4) stats name=uptimeseconds  -> (two-step) stat = 86400
    //  5) jabber:iq:version         -> name=ejabberd version=26.01
    //  6) fetchVhosts disco#items   -> []  (vhostCount falls back to 1 from current domain)
    // Feed these via the same mechanism used by the existing fetchUserList tests.
    // (See NOTE in Task 5 about the response-feeding mechanism.)

    const stats = await xmppClient.admin.fetchServerStats()

    expect(stats.registeredUsers).toBe(15)
    expect(stats.onlineUsers).toBe(7)
    expect(stats.onlineRooms).toBe(10)
    expect(stats.uptimeSeconds).toBe(86400)
    expect(stats.version).toContain('ejabberd')
    expect(typeof stats.fetchedAt).toBe('number')
    expect(emitSDKSpy).toHaveBeenCalledWith('admin:server-stats', { stats })
  })

  it('omits metrics whose command fails, without throwing', async () => {
    // Make get-registered-users-num reject; others succeed/empty.
    const stats = await xmppClient.admin.fetchServerStats()
    expect(stats.registeredUsers).toBeUndefined()
    expect(stats.fetchedAt).toBeGreaterThan(0)
  })
})
```

> Build the response elements with `createAdminMockElement`, matching the shapes captured in the spec's "Data sources" table (e.g. registered → `<field var="registeredusersnum"><value>15</value></field>`).

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t "fetchServerStats"`
Expected: FAIL ("fetchServerStats is not a function").

- [ ] **Step 3: Import additions** at the top of `Admin.ts` — add `NS_VERSION` to the namespaces import and `ServerStats` to the types import.

- [ ] **Step 4: Implement the method** (add after `fetchEntityCounts`, before `executeSimpleCommand`):

```ts
  /**
   * Fetch structured server vital-signs for the overview dashboard.
   * Each metric is fetched independently; a missing/forbidden command omits
   * that metric rather than failing the whole snapshot (discovery-driven).
   */
  async fetchServerStats(_vhost?: string): Promise<ServerStats> {
    const stats: ServerStats = { fetchedAt: Date.now() }

    try {
      const form = await this.executeSimpleCommand('get-registered-users-num')
      const v = form ? getFormFieldValue(form, 'registeredusersnum') : undefined
      if (v != null && v !== '') stats.registeredUsers = parseInt(v, 10)
    } catch { /* unavailable */ }

    try {
      const form = await this.executeSimpleCommand('get-online-users-num')
      const v = form ? getFormFieldValue(form, 'onlineusersnum') : undefined
      if (v != null && v !== '') stats.onlineUsers = parseInt(v, 10)
    } catch { /* unavailable */ }

    try {
      // service=global → count rooms across all vhosts (default is one conference vhost)
      const form = await this.executeApiCommand('muc_online_rooms_count', { service: 'global' })
      const v = form
        ? (getFormFieldValue(form, 'count') ??
           getFormFieldValue(form, 'onlineroomsnum') ??
           getFormFieldValue(form, 'rooms'))
        : undefined
      if (v != null && v !== '') stats.onlineRooms = parseInt(v, 10)
    } catch { /* unavailable */ }

    const uptime = await this.fetchUptimeSeconds()
    if (uptime != null) stats.uptimeSeconds = uptime

    const version = await this.fetchServerVersion()
    if (version) stats.version = version

    try {
      const vhosts = await this.fetchVhosts()
      if (vhosts.length > 0) stats.vhostCount = vhosts.length
    } catch { /* unavailable */ }

    this.deps.emitSDK('admin:server-stats', { stats })
    return stats
  }

  /**
   * Read server uptime via the ejabberd `stats` api-command (name=uptimeseconds).
   * Parses the result value tolerantly — the value field var is not hard-coded.
   */
  private async fetchUptimeSeconds(): Promise<number | null> {
    try {
      const form = await this.executeApiCommand('stats', { name: 'uptimeseconds' })
      if (!form) return null
      for (const field of form.fields) {
        if (field.type === 'fixed' || field.type === 'hidden') continue
        if (field.var === 'name') continue
        const raw = Array.isArray(field.value) ? field.value[0] : field.value
        const n = raw != null ? parseInt(raw, 10) : NaN
        if (!Number.isNaN(n)) return n
      }
    } catch { /* unavailable */ }
    return null
  }

  /** Read server software version via XEP-0092 (jabber:iq:version) on the domain. */
  private async fetchServerVersion(): Promise<string | null> {
    const currentJid = this.deps.getCurrentJid()
    const domain = currentJid ? getDomain(currentJid) : null
    if (!domain) return null
    try {
      const iq = xml(
        'iq',
        { type: 'get', to: domain, id: `ver_${generateUUID()}` },
        xml('query', { xmlns: NS_VERSION })
      )
      const result = await this.deps.sendIQ(iq)
      const query = result.getChild('query', NS_VERSION)
      if (!query) return null
      const name = query.getChild('name')?.text() || ''
      const version = query.getChild('version')?.text() || ''
      const combined = [name, version].filter(Boolean).join(' ').trim()
      return combined || null
    } catch {
      return null
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Admin.test.ts -t "fetchServerStats"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Admin.ts packages/fluux-sdk/src/core/modules/Admin.test.ts
git commit -m "feat(sdk): fetchServerStats vital-signs aggregator"
```

---

### Task 7: Expose via `useAdmin`

**Files:**
- Modify: `packages/fluux-sdk/src/hooks/useAdmin.ts`

- [ ] **Step 1: Subscribe to the new state.** After `const mucServiceJid = useAdminStore((s) => s.mucServiceJid)`:

```ts
  const serverStats = useAdminStore((s) => s.serverStats)
  const isLoadingStats = useAdminStore((s) => s.isLoadingStats)
```

- [ ] **Step 2: Add the action.** After `fetchEntityCounts` (the `useCallback`):

```ts
  // Fetch structured server vital-signs for the overview dashboard.
  const fetchServerStats = useCallback(async () => {
    const store = adminStore.getState()
    store.setIsLoadingStats(true)
    try {
      return await client.admin.fetchServerStats(store.selectedVhost || undefined)
    } finally {
      adminStore.getState().setIsLoadingStats(false)
    }
  }, [client])
```

- [ ] **Step 3: Add `fetchServerStats` to the memoized `actions` object** (both the object literal and its dependency array).

- [ ] **Step 4: Add `serverStats` and `isLoadingStats` to the returned object** (the final `useMemo` value) and to that `useMemo`'s dependency array.

- [ ] **Step 5: Build the SDK and typecheck**

Run: `npm run build:sdk && cd packages/fluux-sdk && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/hooks/useAdmin.ts
git commit -m "feat(sdk): expose serverStats/fetchServerStats via useAdmin"
```

---

## Phase 2 — App: the friendly kit

### Task 8: Pure formatters (`utils/format.ts`)

**Files:**
- Create: `apps/fluux/src/utils/format.ts`
- Test: `apps/fluux/src/utils/format.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { formatDuration, formatCount, formatBytes, formatBoolean, formatDateTime } from './format'

describe('formatDuration', () => {
  it('formats multi-unit durations, largest two units', () => {
    expect(formatDuration(90061)).toBe('1d 1h')          // 1d 1h 1m 1s -> top 2
    expect(formatDuration(3661)).toBe('1h 1m')
    expect(formatDuration(59)).toBe('59s')
    expect(formatDuration(0)).toBe('0s')
  })
  it('honours custom unit labels', () => {
    expect(formatDuration(3661, { d: 'j', h: 'h', m: 'min', s: 's' })).toBe('1h 1min')
  })
})

describe('formatCount', () => {
  it('localizes thousands', () => {
    expect(formatCount(1234567)).toBe((1234567).toLocaleString())
    expect(formatCount(0)).toBe('0')
  })
})

describe('formatBytes', () => {
  it('scales to human units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })
})

describe('formatBoolean', () => {
  it('maps to a symbol', () => {
    expect(formatBoolean(true)).toBe('✓')
    expect(formatBoolean(false)).toBe('—')
  })
})

describe('formatDateTime', () => {
  it('renders a locale string for an epoch ms', () => {
    const ts = 1718880000000
    expect(formatDateTime(ts)).toBe(new Date(ts).toLocaleString())
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/fluux && npx vitest run src/utils/format.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
/**
 * Pure, dependency-free value formatters — the reusable "friendly kit" shared
 * by admin functions (and beyond). No i18n coupling: callers pass localized
 * unit labels where wording matters (e.g. formatDuration).
 */

export interface DurationUnits {
  d: string
  h: string
  m: string
  s: string
}

const DEFAULT_DURATION_UNITS: DurationUnits = { d: 'd', h: 'h', m: 'm', s: 's' }

/**
 * Format a duration in seconds, showing the two largest non-zero units
 * (e.g. 90061 → "1d 1h"). Always returns at least seconds ("0s").
 */
export function formatDuration(totalSeconds: number, units: DurationUnits = DEFAULT_DURATION_UNITS): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const parts: string[] = []
  if (days) parts.push(`${days}${units.d}`)
  if (hours) parts.push(`${hours}${units.h}`)
  if (minutes) parts.push(`${minutes}${units.m}`)
  if (seconds || parts.length === 0) parts.push(`${seconds}${units.s}`)
  return parts.slice(0, 2).join(' ')
}

/** Localized integer (thousands separators). */
export function formatCount(n: number): string {
  return n.toLocaleString()
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  const value = bytes / Math.pow(k, i)
  const rounded = Math.round(value * 10) / 10
  return `${rounded} ${sizes[i]}`
}

/** Boolean → compact symbol (locale-neutral). */
export function formatBoolean(value: boolean): string {
  return value ? '✓' : '—'
}

/** Epoch ms → locale date-time string. */
export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/format.ts apps/fluux/src/utils/format.test.ts
git commit -m "feat(app): add value-formatter kit (utils/format)"
```

---

### Task 9: Card registry (`components/admin/adminOverview.ts`)

**Files:**
- Create: `apps/fluux/src/components/admin/adminOverview.ts`

- [ ] **Step 1: Implement the registry.** Declarative, discovery-driven; each card maps a `ServerStats` key to an icon, an i18n label key, and a value formatter. `t` and `durationUnits` are passed in from the component (i18n stays in React).

```ts
import { Clock, Tag, Users, UserCheck, Hash, Server } from 'lucide-react'
import type { ServerStats } from '@fluux/sdk'
import { formatDuration, formatCount, type DurationUnits } from '@/utils/format'

export interface OverviewCardDef {
  key: keyof ServerStats
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  format: (value: NonNullable<ServerStats[keyof ServerStats]>, durationUnits: DurationUnits) => string
}

/**
 * Curated vital-signs cards. Order = display order. A card renders only when
 * its `key` is present on the ServerStats snapshot (discovery-driven omission,
 * handled by the component). `fetchedAt` is intentionally not a card.
 */
export const OVERVIEW_CARDS: OverviewCardDef[] = [
  { key: 'uptimeSeconds', icon: Clock, labelKey: 'admin.overview.cards.uptime', format: (v, u) => formatDuration(v as number, u) },
  { key: 'version', icon: Tag, labelKey: 'admin.overview.cards.version', format: (v) => String(v) },
  { key: 'registeredUsers', icon: Users, labelKey: 'admin.overview.cards.registeredUsers', format: (v) => formatCount(v as number) },
  { key: 'onlineUsers', icon: UserCheck, labelKey: 'admin.overview.cards.onlineUsers', format: (v) => formatCount(v as number) },
  { key: 'onlineRooms', icon: Hash, labelKey: 'admin.overview.cards.onlineRooms', format: (v) => formatCount(v as number) },
  { key: 'vhostCount', icon: Server, labelKey: 'admin.overview.cards.vhosts', format: (v) => formatCount(v as number) },
]
```

- [ ] **Step 2: Typecheck** (after SDK build so `ServerStats` resolves)

Run: `npm run build:sdk && cd apps/fluux && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/components/admin/adminOverview.ts
git commit -m "feat(app): add server-overview card registry"
```

---

## Phase 3 — App: the overview UI

### Task 10: i18n keys (English source + all locales)

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json` (source of truth) and all 32 other locale files.

- [ ] **Step 1: Add the English keys.** Inside the existing `admin` object in `en.json`, add an `overview` block:

```json
"overview": {
  "title": "Server overview",
  "refresh": "Refresh",
  "updatedAt": "Updated at {{time}}",
  "advanced": "Advanced",
  "advancedHint": "Run a raw server command",
  "empty": "Server statistics are unavailable.",
  "retry": "Retry",
  "units": { "d": "d", "h": "h", "m": "m", "s": "s" },
  "cards": {
    "uptime": "Uptime",
    "version": "Server version",
    "registeredUsers": "Registered users",
    "onlineUsers": "Online users",
    "onlineRooms": "Active rooms",
    "vhosts": "Virtual hosts"
  }
}
```

- [ ] **Step 2: Add a real translation of the same block to every other locale** (`fr.json`, `de.json`, … all 32). Use genuine translations, not the English placeholder (the parity test only checks key presence, but the project standard — see CLAUDE.md / memory — is real translations). French example:

```json
"overview": {
  "title": "Vue d'ensemble du serveur",
  "refresh": "Actualiser",
  "updatedAt": "Mis à jour à {{time}}",
  "advanced": "Avancé",
  "advancedHint": "Exécuter une commande serveur brute",
  "empty": "Les statistiques du serveur sont indisponibles.",
  "retry": "Réessayer",
  "units": { "d": "j", "h": "h", "m": "min", "s": "s" },
  "cards": {
    "uptime": "Disponibilité",
    "version": "Version du serveur",
    "registeredUsers": "Utilisateurs enregistrés",
    "onlineUsers": "Utilisateurs en ligne",
    "onlineRooms": "Salons actifs",
    "vhosts": "Hôtes virtuels"
  }
}
```

> For locales you cannot translate confidently, translate from the English meaning (these are short, common UI terms). Do NOT copy the English values verbatim into non-English locales except where a term is identical.

- [ ] **Step 3: Run the i18n parity test**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: PASS (all locales have the new keys).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/i18n/locales
git commit -m "i18n(admin): add server overview keys in all locales"
```

---

### Task 11: `ServerOverview` component

**Files:**
- Create: `apps/fluux/src/components/ServerOverview.tsx`
- Test: `apps/fluux/src/components/ServerOverview.test.tsx`

- [ ] **Step 1: Write the failing render test.** The app mocks `@fluux/sdk` in `test-setup.ts`; this test overrides `useAdmin` per-case.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServerOverview } from './ServerOverview'

const fetchServerStats = vi.fn()
let adminReturn: Record<string, unknown>

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return { ...actual, useAdmin: () => adminReturn }
})

beforeEach(() => {
  fetchServerStats.mockReset()
  adminReturn = {
    serverStats: { registeredUsers: 15, onlineUsers: 7, onlineRooms: 10, uptimeSeconds: 86400, version: 'ejabberd 26.01', vhostCount: 1, fetchedAt: Date.now() },
    isLoadingStats: false,
    fetchServerStats,
    commandsByCategory: { user: [], stats: [], announcement: [], other: [] },
    executeCommand: vi.fn(),
    isExecuting: false,
  }
})

describe('ServerOverview', () => {
  it('renders a card per present metric', () => {
    render(<ServerOverview />)
    expect(screen.getByText('Registered users')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('Active rooms')).toBeInTheDocument()
    expect(screen.getByText('1d')).toBeInTheDocument() // uptime 86400 -> "1d"
  })

  it('omits cards for absent metrics', () => {
    adminReturn.serverStats = { registeredUsers: 15, fetchedAt: Date.now() }
    render(<ServerOverview />)
    expect(screen.getByText('Registered users')).toBeInTheDocument()
    expect(screen.queryByText('Server version')).not.toBeInTheDocument()
  })

  it('fetches on mount and on Refresh click', () => {
    render(<ServerOverview />)
    expect(fetchServerStats).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(fetchServerStats).toHaveBeenCalledTimes(2)
  })

  it('shows the empty state when no stats are available', () => {
    adminReturn.serverStats = null
    render(<ServerOverview />)
    expect(screen.getByText('Server statistics are unavailable.')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/fluux && npx vitest run src/components/ServerOverview.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the component**

```tsx
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, ChevronRight } from 'lucide-react'
import { useAdmin, type ServerStats, type AdminCommand } from '@fluux/sdk'
import { OVERVIEW_CARDS } from './admin/adminOverview'
import { formatDateTime } from '@/utils/format'

/**
 * Friendly server overview: a discovery-driven grid of vital-signs cards plus
 * an "Advanced" disclosure that preserves the raw stats command runner.
 */
export function ServerOverview() {
  const { t } = useTranslation()
  const {
    serverStats,
    isLoadingStats,
    fetchServerStats,
    commandsByCategory,
    executeCommand,
    isExecuting,
  } = useAdmin()

  // Fetch on mount (idempotent enough; refresh is manual otherwise).
  useEffect(() => {
    void fetchServerStats()
  }, [fetchServerStats])

  const durationUnits = {
    d: t('admin.overview.units.d'),
    h: t('admin.overview.units.h'),
    m: t('admin.overview.units.m'),
    s: t('admin.overview.units.s'),
  }

  const stats = serverStats as ServerStats | null
  const presentCards = stats
    ? OVERVIEW_CARDS.filter(card => stats[card.key] !== undefined && stats[card.key] !== null)
    : []

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-fluux-muted">
          {stats?.fetchedAt
            ? t('admin.overview.updatedAt', { time: formatDateTime(stats.fetchedAt).split(', ').pop() })
            : null}
        </div>
        <button
          onClick={() => { void fetchServerStats() }}
          disabled={isLoadingStats}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-fluux-bg hover:bg-fluux-hover text-fluux-text disabled:opacity-50 transition-colors tap-target"
        >
          <RefreshCw className={`size-4 ${isLoadingStats ? 'animate-spin' : ''}`} />
          {t('admin.overview.refresh')}
        </button>
      </div>

      {/* Cards or empty state */}
      {presentCards.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted py-12">
          <p className="mb-3">{t('admin.overview.empty')}</p>
          <button
            onClick={() => { void fetchServerStats() }}
            className="px-4 py-2 text-sm rounded-lg bg-fluux-brand text-fluux-text-on-accent hover:bg-fluux-brand/90 transition-colors"
          >
            {t('admin.overview.retry')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {presentCards.map(card => {
            const Icon = card.icon
            const value = stats![card.key] as NonNullable<ServerStats[keyof ServerStats]>
            return (
              <div key={String(card.key)} className="p-4 rounded-xl bg-fluux-bg border border-fluux-hover">
                <div className="flex items-center gap-2 text-fluux-muted mb-2">
                  <Icon className="size-4" />
                  <span className="text-xs font-medium">{t(card.labelKey)}</span>
                </div>
                <div className="text-2xl font-semibold text-fluux-text truncate" title={String(value)}>
                  {card.format(value, durationUnits)}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Advanced: raw stats commands (preserved capability) */}
      {commandsByCategory.stats.length > 0 && (
        <details className="mt-6 group">
          <summary className="flex items-center gap-1.5 cursor-pointer text-sm text-fluux-muted hover:text-fluux-text select-none">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
            {t('admin.overview.advanced')}
          </summary>
          <p className="text-xs text-fluux-muted mt-1 ms-5">{t('admin.overview.advancedHint')}</p>
          <div className="mt-2 ms-5 space-y-0.5">
            {commandsByCategory.stats.map((cmd: AdminCommand) => (
              <button
                key={cmd.node}
                onClick={() => { void executeCommand(cmd.node) }}
                disabled={isExecuting}
                className="w-full px-2 py-1.5 rounded flex items-center justify-between text-start text-sm text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text disabled:opacity-50 transition-colors"
              >
                <span className="truncate">{cmd.name}</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
```

> The `commandsByCategory.stats` commands run via `executeCommand`; their result flows to `currentSession`, which `AdminView` already renders through `AdminCommandResult`. No extra result handling needed here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/ServerOverview.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/ServerOverview.tsx apps/fluux/src/components/ServerOverview.test.tsx
git commit -m "feat(app): ServerOverview vital-signs dashboard"
```

---

### Task 12: Wire the overview into AdminView / Dashboard / ChatLayout

**Files:**
- Modify: `apps/fluux/src/components/AdminView.tsx`
- Modify: `apps/fluux/src/components/AdminDashboard.tsx`
- Modify: `apps/fluux/src/components/ChatLayout.tsx`

- [ ] **Step 1: AdminView — render the overview for the `stats` category.** Import it:

```ts
import { ServerOverview } from './ServerOverview'
```

In `renderContent()`, add — before the existing `if (activeCategory === 'users')` block:

```tsx
    if (activeCategory === 'stats') {
      return <ServerOverview />
    }
```

Also extend `getTitle()` and `getIcon()` `switch (activeCategory)` with a `case 'stats':` returning `t('admin.overview.title')` and a `<Server …>` icon (already imported).

- [ ] **Step 2: AdminDashboard — make `stats` a non-expanding category.** Replace the `{hasStats && ( … expandable … )}` block (the `<>` with `CategoryButton` + inline `commandsByCategory.stats.map`) with a single non-expanding button mirroring the Users/Rooms buttons:

```tsx
      {hasStats && (
        <CategoryButton
          icon={BarChart3}
          label={t('admin.categories.statistics')}
          isActive={activeCategory === 'stats'}
          onClick={() => onCategoryChange(activeCategory === 'stats' ? null : 'stats')}
          hasExpandableContent={false}
        />
      )}
```

The raw stats command list now lives in `ServerOverview`'s Advanced disclosure, so the inline `commandsByCategory.stats.map` here is removed.

- [ ] **Step 3: AdminDashboard — badges read `serverStats`; single fetch.** Change the mount effect to fetch the overview stats once, and the count badges to read them. Replace `fetchEntityCounts` in the destructure with `fetchServerStats, serverStats`, then:

```tsx
  useEffect(() => {
    if (commands.length > 0) {
      void fetchServerStats()
      void discoverMucService()
    }
  }, [commands.length, fetchServerStats, discoverMucService])
```

And the Users / Rooms `CategoryButton` `count` props:

```tsx
        count={serverStats?.registeredUsers}
...
        count={serverStats?.onlineRooms}
```

- [ ] **Step 4: ChatLayout — show the main panel for `stats`.** Update `adminHasMainContent` (around `ChatLayout.tsx:480`):

```ts
  const adminHasMainContent = adminSession || adminCategory === 'users' || adminCategory === 'rooms' || adminCategory === 'stats'
```

- [ ] **Step 5: Build SDK + typecheck + lint**

Run: `npm run build:sdk && cd apps/fluux && npx tsc --noEmit && npm run lint`
Expected: PASS

- [ ] **Step 6: Run the admin-related app tests**

Run: `cd apps/fluux && npx vitest run src/components/ServerOverview.test.tsx src/components/AdminRoomView.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/AdminView.tsx apps/fluux/src/components/AdminDashboard.tsx apps/fluux/src/components/ChatLayout.tsx
git commit -m "feat(app): route stats category to ServerOverview, badges from serverStats"
```

---

### Task 13: Update the app `@fluux/sdk` test mock

**Files:**
- Modify: `apps/fluux/src/test-setup.ts`

- [ ] **Step 1: Find the `useAdmin` mock.**

Run: `grep -n "useAdmin" apps/fluux/src/test-setup.ts`

- [ ] **Step 2: Add the new fields** to the mocked `useAdmin` return (so components using them in other tests don't crash): `serverStats: null`, `isLoadingStats: false`, `fetchServerStats: vi.fn()`. If `test-setup.ts` builds the admin mock from a shared object, add them there. If `useAdmin` is not currently mocked in `test-setup.ts`, no change is needed (per-test mocks cover it).

- [ ] **Step 3: Run the full app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, no stderr.

- [ ] **Step 4: Commit (only if changed)**

```bash
git add apps/fluux/src/test-setup.ts
git commit -m "test(app): add serverStats fields to useAdmin mock"
```

---

## Phase 4 — Demo + verification

### Task 14: Seed the overview in demo mode

So the overview renders in `demo.html` for visual verification/screenshots. `DemoClient.sendIQ` (≈`packages/fluux-sdk/src/demo/DemoClient.ts:180`) already routes by namespace; `discoverAdminCommands` does a `disco#items` on the commands node, and the stat/version commands are IQs.

**Files:**
- Modify: `packages/fluux-sdk/src/demo/DemoClient.ts`

- [ ] **Step 1: Advertise admin commands** so `discoverAdminCommands` makes the demo user an admin. In `sendIQ`, before the generic `disco#items` fallthrough, handle a `disco#items` whose `node === NS_COMMANDS` to the domain by returning items including the stats command nodes. Add (near the other disco#items branches):

```ts
    // disco#items on the commands node → advertise a demo admin command set
    if (xmlns === NS_DISCO_ITEMS && queryChild?.attrs?.node === NS_COMMANDS) {
      return this.buildAdminCommandsResponse()
    }
```

- [ ] **Step 2: Answer the stat commands and version.** Extend the existing ad-hoc `commandChild` branch (or add dedicated branches) so:
  - `node` ending `#get-registered-users-num` → form with `registeredusersnum=42`
  - `node` ending `#get-online-users-num` → form with `onlineusersnum=8`
  - `node` `api-commands/muc_online_rooms_count` → two-step, `count=5`
  - `node` `api-commands/stats` → two-step, value `uptimeseconds`-style field `stat=259200`
  - a `jabber:iq:version` query to the domain → `<name>ejabberd</name><version>26.01 (demo)</version>`

Build these with the same element helpers `DemoClient` uses for other responses (`buildCommandResponse` shows the shape). Keep values static.

> This is demo-only seed data — keep it minimal but enough that all six cards render.

- [ ] **Step 3: Build SDK and run the app in demo to verify**

Run: `npm run build:sdk`
Then verify via the preview tools: start the dev server, open `/demo.html`, open the Admin panel (it should now appear because the demo user is an admin), click the Statistics/overview category, and confirm the six cards render with formatted values. Capture a screenshot.

- [ ] **Step 4: Commit**

```bash
git add packages/fluux-sdk/src/demo/DemoClient.ts
git commit -m "feat(demo): seed admin command discovery and server stats"
```

---

### Task 15: Full verification pass

- [ ] **Step 1: Typecheck (root)**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Lint**

Run: `cd apps/fluux && npm run lint` (and SDK lint if defined)
Expected: PASS

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS with no stderr (per CLAUDE.md pre-commit gate).

- [ ] **Step 4: Live check against process-one.net (manual, optional but recommended).** Run the desktop/web app, log in as the admin on process-one.net, open Admin → overview, confirm: uptime is a sensible duration, version shows "ejabberd …", registered/online/rooms/vhosts match the server. Confirm the uptime card is populated (validates the tolerant `stats` value-field parsing against the real `var`). If uptime is blank, capture the `api-commands/stats` complete-step response and adjust the tolerant parser.

- [ ] **Step 5: Final commit if any fixes were needed, then push the branch**

```bash
git push -u origin feat/admin-server-overview
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** UX/screen (Tasks 11–12), SDK `fetchServerStats`+`ServerStats` (Tasks 2, 6), kit `format.ts`+registry (Tasks 8–9), discovery-driven omission (Task 11 `presentCards`), Advanced disclosure (Task 11), refresh + empty state (Task 11), data sources incl. two-step api-commands + `service=global` + tolerant uptime + XEP-0092 version (Tasks 5–6), i18n 33 locales (Task 10), demo seeding (Task 14), tests SDK+formatters+render (Tasks 5,6,8,11). No-auto-poll honoured (mount + manual only).
- **Placeholder scan:** none — all steps carry concrete code/commands. The two NOTEs (Task 5/6) flag harness-adaptation of test plumbing, not missing implementation.
- **Type consistency:** `ServerStats` fields, `fetchServerStats(vhost?)`, `serverStats`/`isLoadingStats`/`setServerStats`/`setIsLoadingStats`, event `admin:server-stats` `{ stats }`, formatter signatures, and `OVERVIEW_CARDS` keys are consistent across all tasks.
