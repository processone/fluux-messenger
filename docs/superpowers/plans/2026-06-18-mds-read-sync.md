# MDS Read-Position Sync (XEP-0490) + Coalescer Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync the 1:1 last-read position across a user's devices via XEP-0490 (Message Displayed Synchronization) over PEP, modelled as a replicated grow-only register; and promote the existing per-key latest-wins buffer into a reusable SDK utility that the MDS publisher consumes.

**Architecture:** A new request/response `Mds` SDK module publishes/fetches the per-conversation last-displayed `stanza-id` to the private PEP node `urn:xmpp:mds:displayed:0` (item id = conversation bare JID, payload = an XEP-0333 `<displayed/>`). Incoming MDS notifications (pushed because we advertise the `+notify` cap) are parsed in the existing `PubSub` module and emitted as an SDK event that a store binding applies forward-only. A debounced side effect (templated on `conversationSyncSideEffects.ts`) watches local read-position advances and publishes them, buffering per-JID through a promoted `keyedCoalescer` util. localStorage stays the per-device durable store + offline buffer + empty-node fallback — PEP is the convergence layer, not a replacement.

**Tech Stack:** TypeScript, `@xmpp/client` (`xml`/`ltx` elements), Zustand vanilla stores, Vitest. XEPs: 0490 (MDS), 0333 (Chat Markers), 0359 (Stable IDs), 0163/0223 (PEP), 0115 (Entity Caps).

## Global Constraints

- **Scope is 1:1 only (MDS Phase 1).** MUC read-position sync is an explicit follow-up and is out of scope for this plan. Do not touch `roomStore`/`roomMeta`.
- **Source-of-truth model is a grow-only register.** The read marker is a monotonic max over archive order. NEVER apply or publish a marker that regresses position. Comparison is by message order (local index), NEVER by wall-clock / `lastReadAt` / publish time.
- **localStorage is not eliminated.** It remains the per-device durable store, the offline write buffer, and the fallback when the PEP node is empty or PEP is unsupported. An unpublished marker is recoverable from localStorage on next connect — so the side effect DROPS pending work on disconnect and re-publishes ahead-of-node markers on reconnect.
- **SDK keeps dependencies minimal** — no new npm dependencies. New utils are zero-dep and live under `packages/fluux-sdk/src/utils/`.
- **Worktree build order:** after any SDK source change, run `npm run build:sdk` AND `npm run typecheck` from repo root (tsup dts can pass while tsc fails). The app resolves `@fluux/sdk` to the built dist; if app tasks fail on a missing new export, rebuild the SDK and ensure `apps/fluux/node_modules/@fluux/sdk` resolves to the worktree's `packages/fluux-sdk`.
- **App test mock parity:** any new `@fluux/sdk` export consumed by the app must be added to the `vi.mock('@fluux/sdk', …)` in `apps/fluux/src/test-setup.ts` (use the `importOriginal` spread), and any new store action referenced by `storeBindings` must exist on the store mock.
- **Commit cadence:** one commit per task (TDD: failing test → impl → passing test → commit). Never include a Claude footer in commit messages.
- **Run SDK tests per-workspace:** `cd packages/fluux-sdk && npx vitest run <file>` — do not run bare `vitest` from repo root.

---

## File Structure

**Part A — Coalescer extraction (do first; Part B consumes it):**
- Create `packages/fluux-sdk/src/utils/keyedCoalescer.ts` — key-generic pure per-key latest-wins buffer (no timers). Promoted from the app.
- Create `packages/fluux-sdk/src/utils/keyedCoalescer.test.ts` — unit tests.
- Modify `packages/fluux-sdk/src/index.ts` — export `createKeyedCoalescer` + types.
- Modify `apps/fluux/src/hooks/notificationCoalescer.ts` — re-export the SDK util (keep `createNotificationCoalescer` name as a thin alias) so `useDesktopNotifications` is untouched.
- Modify `apps/fluux/src/test-setup.ts` — add `createKeyedCoalescer` to the `@fluux/sdk` mock spread.

**Part B — MDS 1:1 read sync:**
- Modify `packages/fluux-sdk/src/core/namespaces.ts` — `NS_CHAT_MARKERS`, `NS_MDS`, `NS_MDS_NOTIFY`.
- Modify `packages/fluux-sdk/src/core/caps.ts` — add `NS_MDS_NOTIFY` to `CLIENT_FEATURES`.
- Create `packages/fluux-sdk/src/core/modules/Mds.ts` — `publishDisplayed`, `fetchAllDisplayed`, parse helper. (Template: `ConversationSync.ts`.)
- Create `packages/fluux-sdk/src/core/modules/Mds.test.ts`.
- Modify `packages/fluux-sdk/src/core/XMPPClient.ts` — instantiate `this.mds`.
- Modify `packages/fluux-sdk/src/core/modules/PubSub.ts` — native incoming-MDS branch → `emitSDK('chat:displayed-synced', …)`.
- Modify `packages/fluux-sdk/src/core/types/sdk-events.ts` — add `chat:displayed-synced` to `ChatEvents`.
- Modify `packages/fluux-sdk/src/core/types/chat.ts` — add `pendingRemoteDisplayedStanzaId?` to `ConversationMetadata`.
- Modify `packages/fluux-sdk/src/stores/chatStore.ts` — `applyRemoteDisplayed` action + pending-resolution in `mergeMAMMessages`.
- Modify `packages/fluux-sdk/src/bindings/storeBindings.ts` — `on('chat:displayed-synced', …)`.
- Create `packages/fluux-sdk/src/core/mdsSideEffects.ts` — debounced per-JID publisher. (Template: `conversationSyncSideEffects.ts`.)
- Create `packages/fluux-sdk/src/core/mdsSideEffects.test.ts`.
- Modify `packages/fluux-sdk/src/core/sideEffects.ts` — wire `setupMdsSideEffects`.
- Modify `apps/fluux/src/test-setup.ts` — add `applyRemoteDisplayed` to the chat store mock.

---

## Task A1: Promote `keyedCoalescer` to the SDK

**Files:**
- Create: `packages/fluux-sdk/src/utils/keyedCoalescer.ts`
- Test: `packages/fluux-sdk/src/utils/keyedCoalescer.test.ts`
- Modify: `packages/fluux-sdk/src/index.ts`
- Modify: `apps/fluux/src/hooks/notificationCoalescer.ts`
- Modify: `apps/fluux/src/test-setup.ts`

**Interfaces:**
- Produces: `createKeyedCoalescer<K = string, V = unknown>(): KeyedCoalescer<K, V>` with `isOpen()`, `open()`, `add(key: K, value: V): boolean`, `flush(): Array<{ key: K; value: V }>`, `drop()`, `size(): number`. Pure — owns no timers.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/utils/keyedCoalescer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { createKeyedCoalescer } from './keyedCoalescer'

describe('createKeyedCoalescer', () => {
  it('buffers latest value per key while open and flushes one entry per key in insertion order', () => {
    const c = createKeyedCoalescer<string, number>()
    expect(c.isOpen()).toBe(false)
    expect(c.add('a', 1)).toBe(false) // closed → not buffered

    c.open()
    expect(c.isOpen()).toBe(true)
    expect(c.add('a', 1)).toBe(true)
    expect(c.add('b', 2)).toBe(true)
    expect(c.add('a', 3)).toBe(true) // latest-wins for 'a'
    expect(c.size()).toBe(2)

    const entries = c.flush()
    expect(entries).toEqual([
      { key: 'a', value: 3 },
      { key: 'b', value: 2 },
    ])
    // flush() clears + closes
    expect(c.isOpen()).toBe(false)
    expect(c.size()).toBe(0)
  })

  it('drop() clears without returning entries and closes the window', () => {
    const c = createKeyedCoalescer<string, number>()
    c.open()
    c.add('a', 1)
    c.drop()
    expect(c.isOpen()).toBe(false)
    expect(c.size()).toBe(0)
    expect(c.flush()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/keyedCoalescer.test.ts`
Expected: FAIL — cannot find module `./keyedCoalescer`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/fluux-sdk/src/utils/keyedCoalescer.ts`:

```typescript
/**
 * Per-key latest-wins coalescing buffer (pure, owns NO timers).
 *
 * The caller controls timing (open the window, flush/drop on its own clock or
 * teardown). While open, the latest value per key wins; while closed, add()
 * returns false so callers can dispatch immediately.
 *
 * Promoted from apps/fluux notificationCoalescer so SDK side effects (e.g. the
 * MDS read-position publisher) can buffer per-conversation publishes. Timer and
 * flush-vs-drop teardown policy deliberately stay at each call site — they
 * diverge per consumer and must remain explicit.
 */
export interface CoalescedEntry<K, V> {
  key: K
  value: V
}

export interface KeyedCoalescer<K, V> {
  /** Whether the coalescing window is currently open. */
  isOpen(): boolean
  /** Open the window; subsequent add() calls buffer instead of returning false. */
  open(): void
  /** Buffer the latest value for key. Returns true if buffered, false if window closed. */
  add(key: K, value: V): boolean
  /** Return one entry per key (latest value, insertion order), clear, and close. */
  flush(): CoalescedEntry<K, V>[]
  /** Clear the buffer and close without returning entries. */
  drop(): void
  /** Number of distinct keys currently buffered. */
  size(): number
}

export function createKeyedCoalescer<K = string, V = unknown>(): KeyedCoalescer<K, V> {
  let open = false
  const buffer = new Map<K, V>()

  return {
    isOpen: () => open,
    open: () => {
      open = true
    },
    add: (key, value) => {
      if (!open) return false
      buffer.set(key, value)
      return true
    },
    flush: () => {
      const entries = Array.from(buffer, ([key, value]) => ({ key, value }))
      buffer.clear()
      open = false
      return entries
    },
    drop: () => {
      buffer.clear()
      open = false
    },
    size: () => buffer.size,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/keyedCoalescer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Export from the SDK and re-point the app**

Add to `packages/fluux-sdk/src/index.ts` (alongside other `utils` exports):

```typescript
export { createKeyedCoalescer } from './utils/keyedCoalescer'
export type { KeyedCoalescer, CoalescedEntry } from './utils/keyedCoalescer'
```

Replace the body of `apps/fluux/src/hooks/notificationCoalescer.ts` with a thin alias so existing consumers (`useDesktopNotifications`) keep working:

```typescript
/**
 * Per-id notification coalescer.
 *
 * Thin alias over the SDK's keyedCoalescer (promoted there so SDK side effects
 * can reuse the same pure per-key latest-wins buffer). Kept as a named alias to
 * avoid churning useDesktopNotifications and its tests.
 */
import { createKeyedCoalescer } from '@fluux/sdk'
import type { KeyedCoalescer, CoalescedEntry } from '@fluux/sdk'

/** @deprecated import shape preserved for useDesktopNotifications. */
export type NotificationCoalescer<T> = KeyedCoalescer<string, T>
export type { CoalescedEntry }

export function createNotificationCoalescer<T>(): NotificationCoalescer<T> {
  return createKeyedCoalescer<string, T>()
}
```

> Note: the old app type used `{ id, payload }` entries; the SDK util uses `{ key, value }`. Check `useDesktopNotifications` for any `.flush()` consumer reading `.id`/`.payload`; if present, update to `.key`/`.value` in this same task (grep: `grep -rn "\.payload\|coalesc" apps/fluux/src/hooks/useDesktopNotifications*`).

Add `createKeyedCoalescer` to the `@fluux/sdk` mock in `apps/fluux/src/test-setup.ts` (inside the `importOriginal` spread, so it returns the real impl):

```typescript
// within vi.mock('@fluux/sdk', async (importOriginal) => { const actual = await importOriginal(); return { ...actual, /* existing overrides */ } })
// createKeyedCoalescer is pure — the importOriginal spread already exposes it; only add an explicit entry if the mock omits the spread.
```

- [ ] **Step 6: Rebuild SDK + verify app still builds**

Run: `npm run build:sdk && npm run typecheck`
Expected: PASS (no type errors). Then `cd packages/fluux-sdk && npx vitest run src/utils/keyedCoalescer.test.ts` and `cd apps/fluux && npx vitest run src/hooks/` (desktop-notification tests still green).

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/utils/keyedCoalescer.ts packages/fluux-sdk/src/utils/keyedCoalescer.test.ts packages/fluux-sdk/src/index.ts apps/fluux/src/hooks/notificationCoalescer.ts apps/fluux/src/test-setup.ts
git commit -m "refactor: promote per-key latest-wins coalescer into the SDK"
```

---

## Task B1: Namespaces + entity-caps feature

**Files:**
- Modify: `packages/fluux-sdk/src/core/namespaces.ts`
- Modify: `packages/fluux-sdk/src/core/caps.ts`
- Test: `packages/fluux-sdk/src/core/caps.test.ts` (extend if present; else create)

**Interfaces:**
- Produces: `NS_CHAT_MARKERS = 'urn:xmpp:chat-markers:0'`, `NS_MDS = 'urn:xmpp:mds:displayed:0'`, `NS_MDS_NOTIFY = 'urn:xmpp:mds:displayed:0+notify'`. `CLIENT_FEATURES` includes `NS_MDS_NOTIFY`.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/core/caps.test.ts` (create the file if it does not exist; import the verification-string helper):

```typescript
import { describe, it, expect } from 'vitest'
import { CLIENT_FEATURES, calculateVerificationString } from './caps'
import { NS_MDS_NOTIFY } from './namespaces'

describe('caps advertises MDS', () => {
  it('includes the MDS +notify feature so the server pushes read-position updates', () => {
    expect(CLIENT_FEATURES).toContain(NS_MDS_NOTIFY)
    // feature appears in the (sorted) XEP-0115 verification string
    expect(calculateVerificationString()).toContain(`${NS_MDS_NOTIFY}<`)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/caps.test.ts`
Expected: FAIL — `NS_MDS_NOTIFY` not exported / not in `CLIENT_FEATURES`.

- [ ] **Step 3: Write minimal implementation**

In `packages/fluux-sdk/src/core/namespaces.ts`, add near `NS_STANZA_ID` / `NS_BOOKMARKS_NOTIFY`:

```typescript
// XEP-0333: Chat Markers
export const NS_CHAT_MARKERS = 'urn:xmpp:chat-markers:0'

// XEP-0490: Message Displayed Synchronization (MDS)
export const NS_MDS = 'urn:xmpp:mds:displayed:0'
export const NS_MDS_NOTIFY = 'urn:xmpp:mds:displayed:0+notify'
```

In `packages/fluux-sdk/src/core/caps.ts`, import and add to `CLIENT_FEATURES`:

```typescript
// add to the import block from './namespaces'
  NS_MDS_NOTIFY,
```

```typescript
// add inside the CLIENT_FEATURES array
  NS_MDS_NOTIFY,         // XEP-0490 PEP notify (read-position sync)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/caps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/namespaces.ts packages/fluux-sdk/src/core/caps.ts packages/fluux-sdk/src/core/caps.test.ts
git commit -m "feat(mds): add XEP-0490 namespaces and advertise +notify cap"
```

---

## Task B2: `Mds` module — publish + fetch

**Files:**
- Create: `packages/fluux-sdk/src/core/modules/Mds.ts`
- Test: `packages/fluux-sdk/src/core/modules/Mds.test.ts`
- Modify: `packages/fluux-sdk/src/core/XMPPClient.ts`

**Interfaces:**
- Consumes: `ModuleDependencies` (from `BaseModule`) — `sendIQ`, `getCurrentJid`. `NS_PUBSUB`, `NS_MDS`, `NS_CHAT_MARKERS` (Task B1). `getBareJid` (`../jid`), `generateUUID` (`../../utils/uuid`).
- Produces:
  - `class Mds` with `publishDisplayed(conversationJid: string, stanzaId: string): Promise<void>` and `fetchAllDisplayed(timeoutMs?: number): Promise<DisplayedMarker[]>`.
  - `interface DisplayedMarker { conversationJid: string; stanzaId: string }`.
  - `function parseMdsItems(itemsEl: Element): DisplayedMarker[]` (exported for reuse by `PubSub` in Task B3).
  - On `XMPPClient`: `public mds!: Mds`.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/core/modules/Mds.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { xml } from '@xmpp/client'
import { Mds, parseMdsItems } from './Mds'
import { NS_PUBSUB, NS_MDS, NS_CHAT_MARKERS } from '../namespaces'

function makeDeps(sendIQ: ReturnType<typeof vi.fn>) {
  return {
    stores: null,
    sendStanza: vi.fn(),
    sendIQ,
    getCurrentJid: () => 'romeo@montague.example/phone',
    emit: vi.fn(),
    emitSDK: vi.fn(),
    getXmpp: () => null,
  } as never
}

describe('Mds.publishDisplayed', () => {
  it('publishes a <displayed/> marker keyed by the conversation bare JID with MDS publish-options', async () => {
    const sendIQ = vi.fn().mockResolvedValue(xml('iq', { type: 'result' }))
    const mds = new Mds(makeDeps(sendIQ))

    await mds.publishDisplayed('juliet@capulet.example', 'stanza-42')

    const iq = sendIQ.mock.calls[0][0]
    expect(iq.attrs.type).toBe('set')
    const publish = iq.getChild('pubsub', NS_PUBSUB)?.getChild('publish')
    expect(publish?.attrs.node).toBe(NS_MDS)
    const item = publish?.getChild('item')
    expect(item?.attrs.id).toBe('juliet@capulet.example')
    const displayed = item?.getChild('displayed', NS_CHAT_MARKERS)
    expect(displayed?.attrs.id).toBe('stanza-42')

    // publish-options: persist, max_items=max, send_last_published_item=never, whitelist
    const fields = iq
      .getChild('pubsub', NS_PUBSUB)
      ?.getChild('publish-options')
      ?.getChild('x')
      ?.getChildren('field')
    const byVar: Record<string, string | undefined> = {}
    for (const f of fields ?? []) byVar[f.attrs.var] = f.getChildText('value') ?? undefined
    expect(byVar['pubsub#persist_items']).toBe('true')
    expect(byVar['pubsub#max_items']).toBe('max')
    expect(byVar['pubsub#send_last_published_item']).toBe('never')
    expect(byVar['pubsub#access_model']).toBe('whitelist')
  })
})

describe('parseMdsItems', () => {
  it('extracts conversationJid + stanzaId from each item', () => {
    const items = xml('items', { node: NS_MDS },
      xml('item', { id: 'juliet@capulet.example' },
        xml('displayed', { xmlns: NS_CHAT_MARKERS, id: 'stanza-42' })),
      xml('item', { id: 'mercutio@montague.example' },
        xml('displayed', { xmlns: NS_CHAT_MARKERS, id: 'stanza-7' })),
      xml('item', { id: 'broken@example' }), // no <displayed/> → skipped
    )
    expect(parseMdsItems(items)).toEqual([
      { conversationJid: 'juliet@capulet.example', stanzaId: 'stanza-42' },
      { conversationJid: 'mercutio@montague.example', stanzaId: 'stanza-7' },
    ])
  })
})

describe('Mds.fetchAllDisplayed', () => {
  it('queries the node and returns parsed markers; empty on missing node', async () => {
    const result = xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_MDS },
          xml('item', { id: 'juliet@capulet.example' },
            xml('displayed', { xmlns: NS_CHAT_MARKERS, id: 'stanza-42' })))))
    const sendIQ = vi.fn().mockResolvedValue(result)
    const mds = new Mds(makeDeps(sendIQ))
    expect(await mds.fetchAllDisplayed()).toEqual([
      { conversationJid: 'juliet@capulet.example', stanzaId: 'stanza-42' },
    ])

    const sendIQErr = vi.fn().mockRejectedValue(new Error('item-not-found'))
    const mds2 = new Mds(makeDeps(sendIQErr))
    expect(await mds2.fetchAllDisplayed()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Mds.test.ts`
Expected: FAIL — cannot find module `./Mds`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/fluux-sdk/src/core/modules/Mds.ts`:

```typescript
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { getBareJid } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { NS_PUBSUB, NS_MDS, NS_CHAT_MARKERS } from '../namespaces'
import type { ModuleDependencies } from './BaseModule'

/** A per-conversation last-displayed marker (XEP-0490). */
export interface DisplayedMarker {
  /** Conversation bare JID (the PEP item id). */
  conversationJid: string
  /** XEP-0359 stanza-id of the last displayed message. */
  stanzaId: string
}

/**
 * Parse the `<items/>` of an MDS node into markers.
 * Items without a `<displayed/>` child carrying an id are skipped.
 * Exported so PubSub can reuse it for incoming `+notify` events.
 */
export function parseMdsItems(itemsEl: Element): DisplayedMarker[] {
  const markers: DisplayedMarker[] = []
  for (const item of itemsEl.getChildren('item')) {
    const conversationJid = item.attrs.id
    const stanzaId = item.getChild('displayed', NS_CHAT_MARKERS)?.attrs.id
    if (conversationJid && stanzaId) {
      markers.push({ conversationJid, stanzaId })
    }
  }
  return markers
}

/**
 * XEP-0490: Message Displayed Synchronization.
 *
 * Publishes/fetches the per-conversation last-displayed stanza-id to the private
 * PEP node `urn:xmpp:mds:displayed:0` (item id = conversation bare JID, payload =
 * an XEP-0333 `<displayed/>`). Request/response only — incoming `+notify` events
 * are handled in PubSub.
 */
export class Mds {
  private deps: ModuleDependencies

  constructor(deps: ModuleDependencies) {
    this.deps = deps
  }

  /**
   * Publish the last-displayed stanza-id for a 1:1 conversation.
   * The node is created on first publish with current-value semantics
   * (max_items=max so all conversations are retained; one item per JID).
   */
  async publishDisplayed(conversationJid: string, stanzaId: string): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    const iq = xml('iq', { type: 'set', id: `mds_set_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: NS_MDS },
          xml('item', { id: conversationJid },
            xml('displayed', { xmlns: NS_CHAT_MARKERS, id: stanzaId }),
          ),
        ),
        xml('publish-options', {},
          xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
            xml('field', { var: 'FORM_TYPE', type: 'hidden' },
              xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options'),
            ),
            xml('field', { var: 'pubsub#persist_items' }, xml('value', {}, 'true')),
            xml('field', { var: 'pubsub#max_items' }, xml('value', {}, 'max')),
            xml('field', { var: 'pubsub#send_last_published_item' }, xml('value', {}, 'never')),
            xml('field', { var: 'pubsub#access_model' }, xml('value', {}, 'whitelist')),
          ),
        ),
      ),
    )

    await this.deps.sendIQ(iq)
  }

  /**
   * Fetch all per-conversation displayed markers from our own MDS node.
   * Returns an empty array if the node does not exist yet.
   */
  async fetchAllDisplayed(timeoutMs?: number): Promise<DisplayedMarker[]> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return []

    const bareJid = getBareJid(currentJid)
    const iq = xml('iq', { type: 'get', to: bareJid, id: `mds_get_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_MDS }),
      ),
    )

    try {
      const result = await this.deps.sendIQ(iq, timeoutMs)
      const items = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')
      if (!items) return []
      return parseMdsItems(items)
    } catch {
      return []
    }
  }
}
```

In `packages/fluux-sdk/src/core/XMPPClient.ts`:
- Add the field declaration near `public conversationSync!: ConversationSync` (around line 310):

```typescript
  public mds!: Mds
```

- Add the import near the other module imports:

```typescript
import { Mds } from './modules/Mds'
```

- Instantiate near `this.conversationSync = new ConversationSync(moduleDeps)` (around line 675):

```typescript
    this.mds = new Mds(moduleDeps)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Mds.test.ts`
Expected: PASS (4 tests). Then `npm run typecheck` (from root) to confirm `XMPPClient` wiring compiles.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Mds.ts packages/fluux-sdk/src/core/modules/Mds.test.ts packages/fluux-sdk/src/core/XMPPClient.ts
git commit -m "feat(mds): add Mds module to publish/fetch XEP-0490 displayed markers"
```

---

## Task B3: Incoming MDS notify → SDK event

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts`
- Modify: `packages/fluux-sdk/src/core/modules/PubSub.ts`
- Test: `packages/fluux-sdk/src/core/modules/PubSub.test.ts` (extend)

**Interfaces:**
- Consumes: `parseMdsItems` (Task B2), `NS_MDS` (Task B1), `getBareJid`, `this.deps.getCurrentJid`, `this.deps.emitSDK`.
- Produces: SDK event `'chat:displayed-synced': { conversationId: string; stanzaId: string }` on `ChatEvents`. PubSub routes own-account MDS notifications to it.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/core/modules/PubSub.test.ts`:

```typescript
import { NS_PUBSUB_EVENT, NS_MDS, NS_CHAT_MARKERS } from '../namespaces'

describe('PubSub incoming MDS notify', () => {
  it('emits chat:displayed-synced for our own MDS node notifications', () => {
    const emitSDK = vi.fn()
    const deps = {
      // ...reuse the test helper that builds ModuleDependencies in this file...
      getCurrentJid: () => 'romeo@montague.example/phone',
      emitSDK,
    }
    const pubsub = makePubSub(deps) // existing helper in this test file
    const message = xml('message', { from: 'romeo@montague.example' },
      xml('event', { xmlns: NS_PUBSUB_EVENT },
        xml('items', { node: NS_MDS },
          xml('item', { id: 'juliet@capulet.example' },
            xml('displayed', { xmlns: NS_CHAT_MARKERS, id: 'stanza-99' })))))

    expect(pubsub.handle(message)).toBe(true)
    expect(emitSDK).toHaveBeenCalledWith('chat:displayed-synced', {
      conversationId: 'juliet@capulet.example',
      stanzaId: 'stanza-99',
    })
  })

  it('ignores MDS notifications that are not from our own bare JID', () => {
    const emitSDK = vi.fn()
    const pubsub = makePubSub({ getCurrentJid: () => 'romeo@montague.example/phone', emitSDK })
    const message = xml('message', { from: 'attacker@evil.example' },
      xml('event', { xmlns: NS_PUBSUB_EVENT },
        xml('items', { node: NS_MDS },
          xml('item', { id: 'juliet@capulet.example' },
            xml('displayed', { xmlns: NS_CHAT_MARKERS, id: 'stanza-99' })))))
    pubsub.handle(message)
    expect(emitSDK).not.toHaveBeenCalledWith('chat:displayed-synced', expect.anything())
  })
})
```

> If `PubSub.test.ts` has no `makePubSub`/deps helper, mirror the dependency-object shape used by `Mds.test.ts` Step 1 and construct `new PubSub(deps)` directly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/PubSub.test.ts`
Expected: FAIL — no `chat:displayed-synced` emission.

- [ ] **Step 3: Write minimal implementation**

In `packages/fluux-sdk/src/core/types/sdk-events.ts`, add to `ChatEvents` (after `chat:message-updated`):

```typescript
  /** XEP-0490: a device synced its last-displayed (read) position for a 1:1 conversation */
  'chat:displayed-synced': {
    /** Conversation bare JID. */
    conversationId: string
    /** XEP-0359 stanza-id of the last displayed message on the publishing device. */
    stanzaId: string
  }
```

In `packages/fluux-sdk/src/core/modules/PubSub.ts`:
- Add imports:

```typescript
import { NS_MDS } from '../namespaces'
import { parseMdsItems } from './Mds'
```

- In `handlePubSubEvent`, add a branch next to the bookmarks branch (around line 136):

```typescript
    if (node === NS_MDS) {
      this.handleMdsUpdate(bareFrom, items)
    }
```

- Add the handler method (mirror `handleBookmarksUpdate`):

```typescript
  /**
   * XEP-0490: apply an incoming displayed-marker notification from our own
   * MDS node. Other entities' MDS nodes are ignored (own-account PEP only).
   */
  private handleMdsUpdate(bareFrom: string, items: Element): void {
    const ownBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    if (!ownBareJid || bareFrom !== ownBareJid) return

    for (const { conversationJid, stanzaId } of parseMdsItems(items)) {
      this.deps.emitSDK('chat:displayed-synced', {
        conversationId: conversationJid,
        stanzaId,
      })
    }
  }
```

> `getBareJid` is already imported in `PubSub.ts` (used by `handleBookmarksUpdate`). If not, add `import { getBareJid } from '../jid'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/PubSub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/types/sdk-events.ts packages/fluux-sdk/src/core/modules/PubSub.ts packages/fluux-sdk/src/core/modules/PubSub.test.ts
git commit -m "feat(mds): route incoming MDS notifications to chat:displayed-synced"
```

---

## Task B4: `chatStore.applyRemoteDisplayed` — forward-only apply

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/chat.ts`
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`
- Test: `packages/fluux-sdk/src/stores/chatStore.mds.test.ts` (new focused file)

**Interfaces:**
- Consumes: `notifState.onMessageSeen` (`./shared/notificationState`), the `messages: Map<string, Message[]>` store field, `conversationMeta`.
- Produces:
  - `ConversationMetadata.pendingRemoteDisplayedStanzaId?: string` (`chat.ts`).
  - Store action `applyRemoteDisplayed(conversationId: string, stanzaId: string): void` — advances `lastSeenMessageId` forward-only by resolving the stanza-id to a local message id; if the stanza-id is not in the loaded messages, stores it in `pendingRemoteDisplayedStanzaId` for later resolution.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/stores/chatStore.mds.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { chatStore } from './chatStore'
import type { Message } from '../core/types/chat'

function msg(id: string, stanzaId: string): Message {
  return {
    type: 'chat', id, stanzaId, from: 'juliet@capulet.example',
    body: id, timestamp: new Date(), isOutgoing: false,
  } as Message
}

describe('chatStore.applyRemoteDisplayed', () => {
  beforeEach(() => chatStore.getState().reset())

  it('advances lastSeenMessageId forward to the local id of the matching stanza-id', () => {
    const cid = 'juliet@capulet.example'
    const s = chatStore.getState()
    // seed three messages + a marker at the first
    s.setMessages?.(cid, [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')])
    // simulate having seen m1
    s.updateLastSeenMessageId(cid, 'm1')

    chatStore.getState().applyRemoteDisplayed(cid, 's3')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.lastSeenMessageId).toBe('m3')
  })

  it('never regresses lastSeenMessageId (incoming marker behind current)', () => {
    const cid = 'juliet@capulet.example'
    const s = chatStore.getState()
    s.setMessages?.(cid, [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')])
    s.updateLastSeenMessageId(cid, 'm3')

    chatStore.getState().applyRemoteDisplayed(cid, 's1') // behind → ignored

    expect(chatStore.getState().conversationMeta.get(cid)?.lastSeenMessageId).toBe('m3')
  })

  it('stores a pending high-water mark when the stanza-id is not yet loaded', () => {
    const cid = 'juliet@capulet.example'
    chatStore.getState().setMessages?.(cid, [msg('m1', 's1')])

    chatStore.getState().applyRemoteDisplayed(cid, 's-future')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe('s-future')
    expect(meta?.lastSeenMessageId).toBe(undefined) // unchanged
  })
})
```

> Use whatever the store's message-seeding setter is. If there is no `setMessages`, seed via the same mechanism existing chatStore tests use (check `chatStore.test.ts` for the helper, e.g. directly setting `messages` through `mergeMAMMessages` or a test setter). Replace `setMessages?.(...)` accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.mds.test.ts`
Expected: FAIL — `applyRemoteDisplayed` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `packages/fluux-sdk/src/core/types/chat.ts`, add to `ConversationMetadata`:

```typescript
  /**
   * XEP-0490: a remote device reported reading up to this stanza-id, but the
   * message is not yet in the local cache. Resolved to lastSeenMessageId once
   * the message arrives (see mergeMAMMessages).
   */
  pendingRemoteDisplayedStanzaId?: string
```

In `packages/fluux-sdk/src/stores/chatStore.ts`, declare the action in the state interface (near `updateLastSeenMessageId`):

```typescript
  /**
   * XEP-0490: apply a remote device's last-displayed marker. Advances
   * lastSeenMessageId forward-only by resolving the stanza-id to a local
   * message id; stores a pending high-water mark if not yet loaded.
   */
  applyRemoteDisplayed: (conversationId: string, stanzaId: string) => void
```

Implement it (near `updateLastSeenMessageId`):

```typescript
  applyRemoteDisplayed: (conversationId, stanzaId) => {
    set((state) => {
      const messages = state.messages.get(conversationId) || []
      const match = messages.find((m) => m.stanzaId === stanzaId)

      const prevMeta = state.conversationMeta.get(conversationId)
      const base: notifState.EntityNotificationState = {
        unreadCount: prevMeta?.unreadCount ?? 0,
        mentionsCount: 0,
        lastReadAt: prevMeta?.lastReadAt,
        lastSeenMessageId: prevMeta?.lastSeenMessageId,
        firstNewMessageId: prevMeta?.firstNewMessageId,
      }

      if (!match) {
        // Not yet loaded — remember it as a high-water mark to resolve later.
        const meta = { ...(prevMeta ?? base), pendingRemoteDisplayedStanzaId: stanzaId }
        const conversationMeta = new Map(state.conversationMeta)
        conversationMeta.set(conversationId, meta as typeof prevMeta extends undefined ? never : NonNullable<typeof prevMeta>)
        return { conversationMeta }
      }

      // Forward-only advance using the shared comparator (compares by index).
      const updated = notifState.onMessageSeen(base, match.id, messages)
      if (updated.lastSeenMessageId === base.lastSeenMessageId) {
        return {} // no advance
      }

      const conversationMeta = new Map(state.conversationMeta)
      conversationMeta.set(conversationId, {
        ...(prevMeta ?? {}),
        ...updated,
        // resolved → clear any stale pending marker
        pendingRemoteDisplayedStanzaId: undefined,
      } as NonNullable<typeof prevMeta>)
      return { conversationMeta }
    })
  },
```

> Match the exact `set`/`conversationMeta`/`conversations` update idiom already used by `updateLastSeenMessageId` in this file (it also mirrors into the combined `conversations` map for persist/back-compat). Copy that mirroring block so the combined map stays consistent. The snippet above shows the `conversationMeta` half; add the same `conversations` mirror as the sibling action does.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.mds.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/types/chat.ts packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.mds.test.ts
git commit -m "feat(mds): apply remote displayed markers forward-only in chatStore"
```

---

## Task B5: Resolve the pending high-water mark on message merge

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (`mergeMAMMessages`)
- Test: `packages/fluux-sdk/src/stores/chatStore.mds.test.ts` (extend)

**Interfaces:**
- Consumes: `pendingRemoteDisplayedStanzaId` (Task B4), `applyRemoteDisplayed` (Task B4).
- Produces: after `mergeMAMMessages` adds messages, if a conversation has a `pendingRemoteDisplayedStanzaId` now present in the merged messages, it is applied and cleared.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/stores/chatStore.mds.test.ts`:

```typescript
it('resolves a pending remote marker once the message arrives via MAM merge', () => {
  const cid = 'juliet@capulet.example'
  const s = chatStore.getState()
  s.setMessages?.(cid, [msg('m1', 's1')])
  s.updateLastSeenMessageId(cid, 'm1')
  s.applyRemoteDisplayed(cid, 's5') // not loaded yet → pending

  // MAM merge brings in m5/s5 (and intermediate)
  s.mergeMAMMessages(
    cid,
    [msg('m2', 's2'), msg('m5', 's5')],
    { complete: true } as never,
    true,
    'forward'
  )

  const meta = chatStore.getState().conversationMeta.get(cid)
  expect(meta?.lastSeenMessageId).toBe('m5')
  expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
})
```

> Match `mergeMAMMessages`'s real signature `(conversationId, messages, rsm, complete, direction)` — adjust the `rsm` arg to a valid `RSMResponse` shape used elsewhere in `chatStore.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.mds.test.ts`
Expected: FAIL — pending marker not resolved (`lastSeenMessageId` still `m1`).

- [ ] **Step 3: Write minimal implementation**

At the end of `mergeMAMMessages` (after messages are merged into state and before returning), resolve any pending marker. Because `mergeMAMMessages` is inside a `set(...)`, resolve in a follow-up after the merge commits. Add, right after the `set(...)` that merges messages:

```typescript
    // XEP-0490: a remote displayed marker may have arrived before its message.
    // Now that messages merged, try to resolve it forward-only.
    const pending = get().conversationMeta.get(conversationId)?.pendingRemoteDisplayedStanzaId
    if (pending) {
      get().applyRemoteDisplayed(conversationId, pending)
    }
```

> `get` is the Zustand store getter already in scope in chatStore actions. If `mergeMAMMessages` performs multiple `set` calls, place this after the final one.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.mds.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.mds.test.ts
git commit -m "feat(mds): resolve pending remote displayed markers on MAM merge"
```

---

## Task B6: Store binding for `chat:displayed-synced`

**Files:**
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts`
- Modify: `apps/fluux/src/test-setup.ts` (chat store mock gains `applyRemoteDisplayed`)
- Test: `packages/fluux-sdk/src/bindings/storeBindings.test.ts` (extend)

**Interfaces:**
- Consumes: SDK event `chat:displayed-synced` (Task B3), `stores.chat.applyRemoteDisplayed` (Task B4).
- Produces: incoming `chat:displayed-synced` → `chat.applyRemoteDisplayed(conversationId, stanzaId)`.

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/bindings/storeBindings.test.ts` (follow the file's existing event-dispatch test pattern):

```typescript
it('applies chat:displayed-synced to the chat store', () => {
  const applyRemoteDisplayed = vi.fn()
  const stores = makeStoreRefs({ chat: { applyRemoteDisplayed } }) // existing helper pattern
  const client = makeFakeClient()
  const unsub = createStoreBindings(client, () => stores)

  client._emitSDK('chat:displayed-synced', {
    conversationId: 'juliet@capulet.example',
    stanzaId: 'stanza-77',
  })

  expect(applyRemoteDisplayed).toHaveBeenCalledWith('juliet@capulet.example', 'stanza-77')
  unsub()
})
```

> Use the test file's existing fake-client / store-ref helpers; the names above are illustrative.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/bindings/storeBindings.test.ts`
Expected: FAIL — handler not registered.

- [ ] **Step 3: Write minimal implementation**

In `packages/fluux-sdk/src/bindings/storeBindings.ts`, add near the other `chat:*` bindings:

```typescript
  on('chat:displayed-synced', ({ conversationId, stanzaId }) => {
    const stores = getStores()
    stores.chat.applyRemoteDisplayed(conversationId, stanzaId)
  })
```

In `apps/fluux/src/test-setup.ts`, ensure the mocked chat store exposes `applyRemoteDisplayed: vi.fn()` (add to the chat store mock object).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/bindings/storeBindings.test.ts`
Expected: PASS. Then `npm run typecheck` from root (StoreRefs `chat` type now requires `applyRemoteDisplayed` — confirm the `StoreRefs`/bindings interface picks it up from the store type).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/bindings/storeBindings.ts packages/fluux-sdk/src/bindings/storeBindings.test.ts apps/fluux/src/test-setup.ts
git commit -m "feat(mds): bind chat:displayed-synced to chatStore.applyRemoteDisplayed"
```

---

## Task B7: Debounced per-JID publisher side effect

**Files:**
- Create: `packages/fluux-sdk/src/core/mdsSideEffects.ts`
- Test: `packages/fluux-sdk/src/core/mdsSideEffects.test.ts`
- Modify: `packages/fluux-sdk/src/core/sideEffects.ts`

**Interfaces:**
- Consumes: `XMPPClient.mds.publishDisplayed`/`fetchAllDisplayed` (Task B2), `createKeyedCoalescer` (Task A1), `chatStore` (`conversationMeta`, `messages`), `connectionStore`, `client.on('online'|'resumed')`, `chat.applyRemoteDisplayed` (Task B4).
- Produces: `setupMdsSideEffects(client: XMPPClient, options?: SideEffectsOptions): () => void`. Exported and called from `setupStoreSideEffects`.

**Behavior (encode the Global Constraints):**
- On `online` (fresh session): `fetchAllDisplayed()`, apply each via `chatStore.applyRemoteDisplayed`, seed `lastKnownNodeStanzaId` per JID, then enable publishing and snapshot the current per-JID `lastSeenMessageId` so the initial seed isn't republished.
- On local `lastSeenMessageId` advance for a conversation: resolve its stanza-id from `messages`; skip if no stanza-id; skip if not ahead of `lastKnownNodeStanzaId` (by local index — no regressive publish); else `add(jid, stanzaId)` to the coalescer and `schedulePublish()`.
- On debounce flush: `publishDisplayed` each buffered entry; on success update `lastKnownNodeStanzaId`. Best-effort (catch + ignore; localStorage retains the marker for reconnect re-publish).
- On `resumed`: do not seed (server replays notifications); keep publishing enabled.
- On disconnect: DROP the coalescer + clear the timer (localStorage is the durable buffer; reconnect re-publishes ahead-of-node markers).

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/core/mdsSideEffects.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setupMdsSideEffects } from './mdsSideEffects'
import { chatStore, connectionStore } from '../stores'
import type { Message } from './types/chat'

function msg(id: string, stanzaId: string): Message {
  return { type: 'chat', id, stanzaId, from: 'juliet@capulet.example', body: id, timestamp: new Date(), isOutgoing: false } as Message
}

function makeClient() {
  const handlers: Record<string, Array<(p?: unknown) => void>> = {}
  return {
    on: (ev: string, cb: (p?: unknown) => void) => {
      ;(handlers[ev] ||= []).push(cb)
      return () => { handlers[ev] = (handlers[ev] || []).filter((h) => h !== cb) }
    },
    _emit: (ev: string, p?: unknown) => (handlers[ev] || []).forEach((h) => h(p)),
    mds: {
      publishDisplayed: vi.fn().mockResolvedValue(undefined),
      fetchAllDisplayed: vi.fn().mockResolvedValue([]),
    },
  }
}

describe('setupMdsSideEffects', () => {
  beforeEach(() => { vi.useFakeTimers(); chatStore.getState().reset() })
  afterEach(() => vi.useRealTimers())

  it('publishes the resolved stanza-id once, debounced, on a local read advance', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online' } as never)
    const cleanup = setupMdsSideEffects(client as never)

    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // let the async seed settle

    chatStore.getState().setMessages?.(cid, [msg('m1', 's1'), msg('m2', 's2')])
    chatStore.getState().updateLastSeenMessageId(cid, 'm2')

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled() // still debouncing
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2')
    cleanup()
  })

  it('does not publish a marker with no stanza-id', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    chatStore.getState().setMessages?.(cid, [{ ...msg('m1', ''), stanzaId: undefined } as Message])
    chatStore.getState().updateLastSeenMessageId(cid, 'm1')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('drops pending publishes on disconnect', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    chatStore.getState().setMessages?.(cid, [msg('m1', 's1')])
    chatStore.getState().updateLastSeenMessageId(cid, 'm1')
    connectionStore.setState({ status: 'connecting' } as never) // disconnect
    await vi.advanceTimersByTimeAsync(5_000)

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })
})
```

> Match the seeding setter (`setMessages?.`) and `connectionStore` shape to this repo's helpers, exactly as in `conversationSyncSideEffects.test.ts` (which uses `connectionStore`/`chatStore` directly). Reuse `localStorageMock` from the side-effects test helpers if `reset()` touches localStorage.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/mdsSideEffects.test.ts`
Expected: FAIL — cannot find module `./mdsSideEffects`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/fluux-sdk/src/core/mdsSideEffects.ts` (templated on `conversationSyncSideEffects.ts`):

```typescript
/**
 * XEP-0490 read-position publisher.
 *
 * Watches local last-read advances (chatStore.conversationMeta.lastSeenMessageId)
 * and publishes the resolved stanza-id per conversation to the MDS PEP node,
 * debounced and coalesced per-JID (latest-wins). Never publishes a regressive
 * marker. On fresh session it first seeds from the node. localStorage remains the
 * durable buffer, so pending work is DROPPED on disconnect and re-published on
 * reconnect.
 *
 * @module Core/MdsSideEffects
 */

import type { XMPPClient } from './XMPPClient'
import type { SideEffectsOptions } from './chatSideEffects'
import { chatStore, connectionStore } from '../stores'
import { createKeyedCoalescer } from '../utils/keyedCoalescer'
import { getBareJid } from './jid'
import { logInfo } from './logger'

/** Debounce window for read-position publishes (ms). */
const PUBLISH_DEBOUNCE_MS = 1_500

export function setupMdsSideEffects(
  client: XMPPClient,
  options: SideEffectsOptions = {}
): () => void {
  const { debug: _debug = false } = options

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let syncEnabled = false
  // Dirty per-JID buffer (jid → stanzaId), latest-wins.
  const dirty = createKeyedCoalescer<string, string>()
  // Highest stanza-id we know is on the node per JID (seed + our publishes + notify echoes).
  const lastKnownNodeStanzaId = new Map<string, string>()
  // Snapshot of the lastSeenMessageId we last considered, per JID, to detect advances.
  const lastConsideredSeenId = new Map<string, string | undefined>()

  /** Index of a stanza-id in a conversation's loaded messages, or -1. */
  function indexOfStanza(conversationId: string, stanzaId: string | undefined): number {
    if (!stanzaId) return -1
    const messages = chatStore.getState().messages.get(conversationId) || []
    return messages.findIndex((m) => m.stanzaId === stanzaId)
  }

  /** Resolve the stanza-id of a conversation's current lastSeenMessageId. */
  function resolveSeenStanzaId(conversationId: string): string | undefined {
    const meta = chatStore.getState().conversationMeta.get(conversationId)
    const seenId = meta?.lastSeenMessageId
    if (!seenId) return undefined
    const messages = chatStore.getState().messages.get(conversationId) || []
    return messages.find((m) => m.id === seenId)?.stanzaId
  }

  function schedulePublish(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void doPublish()
    }, PUBLISH_DEBOUNCE_MS)
  }

  async function doPublish(): Promise<void> {
    if (connectionStore.getState().status !== 'online') return
    const entries = dirty.flush()
    dirty.open() // reopen for subsequent advances
    for (const { key: jid, value: stanzaId } of entries) {
      try {
        await client.mds.publishDisplayed(jid, stanzaId)
        lastKnownNodeStanzaId.set(jid, stanzaId)
      } catch {
        // Best-effort: localStorage keeps the marker; reconnect re-publishes.
      }
    }
  }

  /** Consider a conversation for publishing if its read position advanced. */
  function consider(conversationId: string): void {
    if (!syncEnabled) return
    const meta = chatStore.getState().conversationMeta.get(conversationId)
    const seenId = meta?.lastSeenMessageId
    if (seenId === lastConsideredSeenId.get(conversationId)) return
    lastConsideredSeenId.set(conversationId, seenId)

    const stanzaId = resolveSeenStanzaId(conversationId)
    if (!stanzaId) return // no stable id yet → skip (will retry on next advance/merge)

    // No regressive publish: only if ahead of what we believe is on the node.
    const nodeId = lastKnownNodeStanzaId.get(conversationId)
    if (nodeId) {
      const candidateIdx = indexOfStanza(conversationId, stanzaId)
      const nodeIdx = indexOfStanza(conversationId, nodeId)
      if (candidateIdx !== -1 && nodeIdx !== -1 && candidateIdx <= nodeIdx) return
    }

    dirty.add(conversationId, stanzaId)
    schedulePublish()
  }

  // Watch conversationMeta for read-position changes.
  const unsubscribeStore = chatStore.subscribe(
    (state) => state.conversationMeta,
    () => {
      if (!syncEnabled) return
      for (const jid of chatStore.getState().conversationMeta.keys()) {
        consider(jid)
      }
    }
  )

  // Fresh session: seed from the node, then enable publishing.
  const unsubscribeOnline = client.on('online', () => {
    syncEnabled = false
    void (async () => {
      const markers = await client.mds.fetchAllDisplayed()
      for (const { conversationJid, stanzaId } of markers) {
        const bare = getBareJid(conversationJid)
        lastKnownNodeStanzaId.set(bare, stanzaId)
        chatStore.getState().applyRemoteDisplayed(bare, stanzaId)
      }
      dirty.drop()
      dirty.open()
      // Snapshot current positions so the seed isn't republished.
      lastConsideredSeenId.clear()
      for (const [jid, meta] of chatStore.getState().conversationMeta) {
        lastConsideredSeenId.set(jid, meta.lastSeenMessageId)
      }
      syncEnabled = true
      logInfo('MDS: seeded read positions and enabled publishing')
    })()
  })

  // SM resume: server replays notifications; keep publishing on, no reseed.
  const unsubscribeResumed = client.on('resumed', () => {
    syncEnabled = true
    dirty.open()
  })

  // Disconnect: drop pending work and cancel the timer.
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
        syncEnabled = false
        dirty.drop()
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = undefined
        }
      }
      previousStatus = status
    }
  )

  return () => {
    unsubscribeStore()
    unsubscribeOnline()
    unsubscribeResumed()
    unsubscribeConnection()
    dirty.drop()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }
}
```

Wire it into `packages/fluux-sdk/src/core/sideEffects.ts`:
- Import + re-export:

```typescript
import { setupMdsSideEffects } from './mdsSideEffects'
export { setupMdsSideEffects } from './mdsSideEffects'
```

- Inside `setupStoreSideEffects`, add to the setup + cleanup list (mirror `setupConversationSyncSideEffects`):

```typescript
  const unsubscribeMds = setupMdsSideEffects(client, options)
```

```typescript
    unsubscribeMds()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/mdsSideEffects.test.ts`
Expected: PASS (3 tests). Then `npm run typecheck` from root.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/mdsSideEffects.ts packages/fluux-sdk/src/core/mdsSideEffects.test.ts packages/fluux-sdk/src/core/sideEffects.ts
git commit -m "feat(mds): debounced per-conversation read-position publisher"
```

---

## Task B8: Full-suite verification + SDK rebuild

**Files:** none (verification only).

- [ ] **Step 1: SDK unit tests**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: all pass, no stderr.

- [ ] **Step 2: Rebuild SDK so the app sees new exports**

Run: `npm run build:sdk`
Expected: success. Confirm `apps/fluux/node_modules/@fluux/sdk` resolves to the worktree's package (symlink) per the worktree gotcha.

- [ ] **Step 3: App tests + typecheck + lint**

Run: `cd apps/fluux && npx vitest run` then from root `npm run typecheck && npm run lint`
Expected: all pass. Fix any `@fluux/sdk` mock gaps (`createKeyedCoalescer`, `applyRemoteDisplayed`).

- [ ] **Step 4: Commit any test-mock fixes**

```bash
git add -A
git commit -m "test(mds): align app SDK mocks with new exports"
```

---

## Out of scope (follow-ups, do NOT implement here)

- **MUC read-position sync** (the bigger UX win, since room read state is ephemeral today). Needs room-JID stanza-id selection (`parseStanzaId(el, roomJid)`), `roomStore.applyRemoteDisplayed`, and routing `chat:displayed-synced` → room vs chat by JID. Track as a separate plan.
- **Emitting an XEP-0333 `<displayed/>` to the peer** (read receipts the contact sees). MDS is private; this is a separate product decision.
- **Node config self-heal** on `precondition-not-met` (delete + recreate like the OpenPGP node). Add only if a real server rejects the `max_items=max`/whitelist config.
- **Migrating the #518 occupant-avatar batch** onto `keyedCoalescer`. Optional consolidation; its fixed-window+drop semantics differ, so don't block on it.

---

## Self-Review

**Spec coverage (against the two synthesized verdicts):**
- Coalescer extraction verdict (promote the pure buffer, keep timers inline) → Task A1 + consumed inline in B7. ✅
- MDS wiring (namespaces, caps `+notify`, module, incoming notify, store apply, debounced publish, fresh-session seed) → B1–B7. ✅
- Source-of-truth invariants: forward-only by archive index (B4 `onMessageSeen` reuse; B7 `indexOfStanza` guard) ✅; localStorage retained as durable buffer + drop-on-disconnect + reconnect re-publish (B7) ✅; raw stanza-id stored when unresolved (B4 pending + B5 resolution) ✅; explicit `fetchAllDisplayed` seed because `send_last_published_item=never` (B7 online handler) ✅; capability gating via `+notify` cap (B1) and best-effort publish that no-ops when PEP rejects (B7 catch) ✅; publishing the own-account-archive stanza-id (B7 resolves from the local message's `stanzaId`, stamped by own server for 1:1) ✅.

**Placeholder scan:** no "TBD/handle edge cases" steps; every code step contains real code. Two intentional "match the repo's existing helper" notes (message-seeding setter, `mergeMAMMessages` rsm arg, storeBindings test helpers) are flagged because those helper names must be read from the actual test files at execution time — they are not inventable from the plan.

**Type consistency:** `applyRemoteDisplayed(conversationId, stanzaId)` used identically in B4 (def), B5 (call), B6 (binding), B7 (seed). `DisplayedMarker { conversationJid, stanzaId }` consistent B2↔B3↔B7. Event `chat:displayed-synced { conversationId, stanzaId }` consistent B3↔B6. `createKeyedCoalescer<K,V>` entries are `{ key, value }` — B7 consumes `.key`/`.value` (matches A1; the app alias in A1 maps the old `.id`/`.payload` consumer).
