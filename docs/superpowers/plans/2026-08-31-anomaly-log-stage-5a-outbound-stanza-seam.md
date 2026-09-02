# Anomaly log stage 5a — outbound application stanza seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first of the four stage-5 SDK seams — `onApplicationStanzaOut` — and the two
detectors it unblocks, `xmpp-traffic/redundant-query` and `xmpp-traffic/iq-unanswered`.

**Architecture:** The SDK gains one public subscription over the two application-layer send paths
that already exist (`XMPPClient.sendStanza` and `XMPPClient.sendIQ`), emitting the `Element` the
caller already built — no payload construction, no new type. The app subscribes to that seam and to
the existing inbound `onStanza`, classifies each outbound IQ into a closed set of query kinds, and
runs a pure state machine that pairs requests with replies. All anomaly-system code stays in
`apps/fluux/src/anomaly/`.

**Tech Stack:** TypeScript, vitest, `@xmpp/client` (ltx `Element`), Zustand (untouched here).

**Spec:** `docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md` §5.2, §5.5, §8.

> **Status:** Implemented. Later review moved observation to the shared real/demo send boundary,
> assigned IQ ids before that boundary, and isolated every subscriber's snapshot. The public SDK
> doc comments, benchmark README, and anomaly invariant registry own the current contracts; code
> excerpts below preserve the implementation plan rather than restating those owners.

## Stage 5 is four plans, not one

The spec's stage 5 covers four independent seams. Each is independently useful and independently
revertable, and each unblocks a different detector family, so each gets its own plan:

| Plan | Seam | Unblocks |
|---|---|---|
| **5a — this plan** | `onApplicationStanzaOut` | `xmpp-traffic/redundant-query`, `xmpp-traffic/iq-unanswered` |
| 5b | Archive-merge outcome seam | MAM merge yield as an informational rate, plus `xmpp-traffic/mam-write-failed` |
| 5c | scoped `readStateGeneration` | `read-state/pointer-regression` |
| 5d | unread diagnostic returning both counts from one guarded snapshot | Exported diagnostic seam; detector objective withdrawn (design §5.1) |

The 5b–5d follow-up plans record those outcomes. MAM merge yield is deliberately **not** in this
plan: it cannot be built from an outbound hook, because retention is decided downstream of the
typed MAM event.

## Global Constraints

- **No anomaly-system code enters `dist`.** The seam emits an ltx `Element`; `Token`, `LocalRef` and
  the HMAC key stay in `apps/fluux/src/anomaly/`. The app tokenizes at the recorder boundary.
- **Hot-path budget.** Each seam is a null check plus at most one dispatch. No payload object may be
  constructed when no handler is registered, and the per-stanza cost with no subscriber must stay
  within noise of the unsubscribed baseline. A measurable regression means the seam gets redesigned,
  not accepted with a note.
- **A diagnostic seam must never break a send.** A throwing subscriber is contained and reported;
  the stanza still goes out.
- **Named coverage gap, carried into the registry:** connection-level sends bypass the application
  layer (the keepalive ping at `core/modules/Connection.ts:1238` and the SM `<r/>` nonza at `:1336`
  go straight to the transport). `iq-unanswered` therefore cannot see a stalled ping or an
  unacknowledged SM request. Instrumenting the transport is out of scope for this slice.
- **Registries are closed.** Every new id, ctx key and tag is minted in
  `apps/fluux/src/anomaly/values.ts`; `Scalar` is `Opaque | number | boolean | null`, so no raw
  string — no JID, no stanza id, no namespace — may reach a record.
- **Parity is asserted, not assumed.** Every new `ID` entry needs a matching row in
  `docs/ANOMALY_INVARIANTS.md`; `values.test.ts` checks both directions.

## Facts established by reading the code (2026-08-31)

These are verified, not inherited from the spec. Later tasks depend on them.

1. **The application layer has exactly two send paths.** `XMPPClient.sendStanza`
   (`core/XMPPClient.ts:1824`) and `XMPPClient.sendIQ` (`:1834`). `moduleDeps.sendStanza` / `sendIQ`
   (`:683-684`) funnel every module through them, and `buildE2EEPrimitives().sendStanza` (`:1801`)
   goes through `sendStanza` too. The `getXmpp()` calls in `MAM.ts` are the **collector fallback for
   tests**, not sends — every real MAM query calls `this.deps.sendIQ`.
2. **`iqCaller.request()` assigns the stanza id.** `node_modules/@xmpp/iq/caller.js:42-44` sets
   `stanza.attrs.id` synchronously at the top of `request()`, before its first `await`. So the id is
   present immediately after the call returns its promise, and **not before**. Emitting before the
   call would publish an id-less IQ that can never be paired with a reply.
3. **IQ replies do reach `onStanza`.** `@xmpp/connection/index.js:96-97` emits `element` (which
   feeds the middleware chain, and so `iqCaller._route`) **and** `stanza`, unconditionally.
   `Connection.ts:2273` listens to `stanza`, and `XMPPClient` re-emits it at `:763`. The iqCaller
   consuming a reply in middleware therefore does not hide it from the app.
4. **The installer can reach the client.** `AnomalyInstaller` is mounted inside `XMPPProvider`
   (`main.tsx:157`, `demo.tsx:277`); `useXMPPContext()` returns `{ client }`.
5. **`install()` currently takes no arguments** and holds a refcount (`attachRefs`) with a single
   attach/detach block. The client subscription joins that block.

---

### Task 1: The SDK seam

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/client.ts` (add the event to `XMPPClientEvents`)
- Modify: `packages/fluux-sdk/src/core/XMPPClient.ts` (`onApplicationStanzaOut`, the private
  dispatcher, and the two emit sites)
- Test: `packages/fluux-sdk/src/core/XMPPClient.outboundStanza.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `client.onApplicationStanzaOut(handler: (stanza: Element) => void): () => void`, and the
  bus event `applicationStanzaOut: (stanza: Element) => void` on `XMPPClientEvents`.

The event goes on `XMPPClientEvents` rather than `InternalClientEvents` for one reason: `stanza` is
already there and `onStanza` is its wrapper. Consistency with the inbound half is worth more than
keeping `on()` one key narrower.

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/core/XMPPClient.outboundStanza.test.ts`. The suite drives a client
whose transport is a stub, so it asserts the seam and nothing else.

```typescript
import { describe, it, expect, vi } from 'vitest'
import xml from '@xmpp/xml'
import type { Element } from '@xmpp/client'
import { XMPPClient } from './XMPPClient'

/** Reach the protected send paths without a real connection. */
class TestClient extends XMPPClient {
  public sent: Element[] = []
  public iqRequests: Element[] = []

  constructor(private readonly failSend = false) {
    super({ service: 'ws://localhost:5280/ws', domain: 'example.com' })
    const self = this
    // requireTransport() is what the send paths call to get the transport.
    ;(this as unknown as { requireTransport: () => unknown }).requireTransport = () => ({
      send: async (stanza: Element) => {
        if (self.failSend) throw new Error('socket closed')
        self.sent.push(stanza)
      },
      iqCaller: {
        request: (iq: Element) => {
          // Mirrors @xmpp/iq/caller.js: the id is assigned inside request().
          if (!iq.attrs.id) iq.attrs.id = 'assigned-1'
          self.iqRequests.push(iq)
          return new Promise<Element>(() => {})
        },
      },
    })
  }

  sendStanzaForTest(stanza: Element): Promise<void> {
    return this.sendStanza(stanza)
  }

  sendIQForTest(iq: Element): Promise<Element> {
    return this.sendIQ(iq)
  }
}

describe('onApplicationStanzaOut', () => {
  it('reports a stanza sent through sendStanza', async () => {
    const client = new TestClient()
    const seen: Element[] = []
    client.onApplicationStanzaOut((s) => seen.push(s))

    const message = xml('message', { to: 'a@example.com' }, xml('body', {}, 'hi'))
    await client.sendStanzaForTest(message)

    expect(seen).toHaveLength(1)
    expect(seen[0].name).toBe('message')
  })

  it('reports an IQ only after its id has been assigned', async () => {
    const client = new TestClient()
    const ids: Array<string | undefined> = []
    client.onApplicationStanzaOut((s) => ids.push(s.attrs.id as string | undefined))

    void client.sendIQForTest(xml('iq', { type: 'get', to: 'example.com' }))

    // An id-less outbound IQ can never be paired with its reply, so publishing one
    // would be worse than publishing nothing.
    expect(ids).toEqual(['assigned-1'])
  })

  it('stops reporting after unsubscribe', async () => {
    const client = new TestClient()
    const seen: Element[] = []
    const off = client.onApplicationStanzaOut((s) => seen.push(s))
    off()

    await client.sendStanzaForTest(xml('presence'))

    expect(seen).toEqual([])
  })

  it('sends the stanza even when a subscriber throws', async () => {
    const client = new TestClient()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    client.onApplicationStanzaOut(() => {
      throw new Error('detector bug')
    })

    await client.sendStanzaForTest(xml('message', { to: 'a@example.com' }))

    expect(client.sent).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/XMPPClient.outboundStanza.test.ts`
Expected: FAIL — `client.onApplicationStanzaOut is not a function`.

- [ ] **Step 3: Declare the event**

In `packages/fluux-sdk/src/core/types/client.ts`, inside `XMPPClientEvents`, directly under the
`stanza` entry:

```typescript
  /**
   * An application-layer stanza was handed to the transport.
   *
   * Connection-level sends — the keepalive ping and the Stream Management `<r/>`
   * nonza — bypass this layer and are therefore NOT reported. Subscribe through
   * {@link XMPPClient.onApplicationStanzaOut}.
   */
  applicationStanzaOut: (stanza: Element) => void
```

- [ ] **Step 4: Implement the subscription and the dispatcher**

In `packages/fluux-sdk/src/core/XMPPClient.ts`, next to `onStanza` (around `:977`):

```typescript
  /**
   * Subscribe to application-layer stanzas on their way out.
   *
   * The counterpart to {@link onStanza}. Reports everything sent through the
   * application layer — messages, presence and IQ requests, including the id
   * `iqCaller` assigns — and nothing sent by the connection machine itself, so a
   * keepalive ping and an SM `<r/>` are invisible here by construction.
   *
   * @param handler - Callback invoked for each outbound application stanza
   * @returns A function to unsubscribe
   */
  onApplicationStanzaOut(handler: (stanza: Element) => void): () => void {
    return this.subscribeToBus('applicationStanzaOut', handler)
  }

  /**
   * Dispatch on the outbound hot path.
   *
   * Deliberately not `emit()`: that builds a rest-args array on every call, and this
   * runs for every stanza the app sends. With no subscriber the cost is one Map
   * lookup. A handler that throws is contained — a diagnostic subscriber must never
   * stop a stanza from being sent.
   */
  private emitApplicationStanzaOut(stanza: Element): void {
    const handlers = this.eventHandlers.get('applicationStanzaOut')
    if (!handlers || handlers.size === 0) return
    for (const handler of handlers) {
      try {
        ;(handler as (s: Element) => void)(stanza)
      } catch (err) {
        console.warn('[XMPPClient] applicationStanzaOut subscriber threw:', err)
      }
    }
  }
```

- [ ] **Step 5: Emit from both send paths**

In `sendStanza` (`:1824`), before the transport call:

```typescript
  protected async sendStanza(stanza: Element): Promise<void> {
    const xmpp = this.requireTransport('', { checkSocket: true })
    this.emitApplicationStanzaOut(stanza)
    try {
      await xmpp.send(stanza)
    } catch (err) {
      this.repairAndRethrowSendError(err)
    }
  }
```

In `sendIQ` (`:1834`), after `request()` — which is where the id gets assigned:

```typescript
  protected async sendIQ(iq: Element, timeoutMs?: number): Promise<Element> {
    const xmpp = this.requireTransport('IQ', { checkSocket: true })
    try {
      const request = xmpp.iqCaller.request(iq)
      // After request(), never before: iqCaller assigns the id inside it, and an
      // id-less outbound IQ cannot be paired with its reply.
      this.emitApplicationStanzaOut(iq)
      if (timeoutMs != null) {
        return await Promise.race([
          request,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new RequestTimeoutError(timeoutMs)), timeoutMs)
          ),
        ])
      }
      return await request
    } catch (err) {
      this.repairAndRethrowSendError(err)
    }
  }
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/XMPPClient.outboundStanza.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Run the SDK suite and typecheck**

Run: `npx vitest run -w @fluux/sdk` (or `npm test`) and `npm run typecheck`
Expected: no new failures. `XMPPClient.test.ts` must stay green — the seam adds a dispatch to paths
it already exercises.

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/core/types/client.ts packages/fluux-sdk/src/core/XMPPClient.ts \
        packages/fluux-sdk/src/core/XMPPClient.outboundStanza.test.ts
git commit -m "feat(sdk): report application stanzas on their way out"
```

---

### Task 2: Measure the hot-path cost

**Files:**
- Create: `packages/fluux-sdk/bench/outboundSeam.bench.ts`
- Modify: `packages/fluux-sdk/package.json` (add `bench:seam`)
- Modify: `packages/fluux-sdk/bench/README.md` (one paragraph)

**Interfaces:**
- Consumes: `onApplicationStanzaOut` from Task 1.
- Produces: a number to quote in the pull request. No runtime artefact.

The spec makes this a merge gate, not a nicety: the seam ships in `dist` to every SDK consumer.

- [ ] **Step 1: Write the benchmark**

```typescript
/**
 * Per-stanza cost of the outbound seam, with and without a subscriber.
 *
 * The budget is "within noise of the unsubscribed baseline". A measurable
 * regression means the seam gets redesigned, not accepted with a note
 * (design §5.5).
 */
import { bench, describe } from 'vitest'
import xml from '@xmpp/xml'
import type { Element } from '@xmpp/client'

type Handler = (stanza: Element) => void

/** The dispatcher under measurement, isolated from the transport. */
function makeDispatcher(): { emit: (s: Element) => void; add: (h: Handler) => void } {
  const handlers = new Set<Handler>()
  return {
    add: (h) => handlers.add(h),
    emit: (stanza) => {
      if (handlers.size === 0) return
      for (const handler of handlers) {
        try {
          handler(stanza)
        } catch {
          // measured path only
        }
      }
    },
  }
}

const stanza = xml('message', { to: 'a@example.com', id: 'x1' }, xml('body', {}, 'hello'))

describe('outbound seam dispatch', () => {
  bench('no subscriber', () => {
    const d = makeDispatcher()
    for (let i = 0; i < 10_000; i++) d.emit(stanza)
  })

  bench('one subscriber', () => {
    const d = makeDispatcher()
    let seen = 0
    d.add(() => { seen++ })
    for (let i = 0; i < 10_000; i++) d.emit(stanza)
  })
})
```

- [ ] **Step 2: Add the script**

In `packages/fluux-sdk/package.json`, beside `bench:persist`:

```json
    "bench:seam": "vitest bench --config vitest.bench.config.ts --run bench/outboundSeam.bench.ts",
```

- [ ] **Step 3: Run it and record the numbers**

Run: `npm run bench:seam -w @fluux/sdk`
Expected: the two rows print. Record both in the pull request body. If "no subscriber" is
distinguishable from an empty loop by more than measurement noise, stop and redesign the dispatcher
before continuing.

- [ ] **Step 4: Document it**

Add to `packages/fluux-sdk/bench/README.md`:

```markdown
## Outbound seam dispatch

```bash
npm run bench:seam -w @fluux/sdk
```

The per-stanza cost of `onApplicationStanzaOut` with and without a subscriber. The seam ships in
`dist` to every SDK consumer, so the unsubscribed path must stay a Map lookup.
```

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/bench/outboundSeam.bench.ts packages/fluux-sdk/bench/README.md \
        packages/fluux-sdk/package.json
git commit -m "bench(sdk): measure the outbound seam dispatch cost"
```

---

### Task 3: Classify an outbound stanza

**Files:**
- Create: `apps/fluux/src/anomaly/detectors/stanzaFacts.ts`
- Test: `apps/fluux/src/anomaly/detectors/stanzaFacts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```typescript
  export type QueryKind = 'disco-info' | 'disco-items' | 'vcard' | 'avatar' | 'mam' | 'roster' | 'other'
  export interface ElementLike {
    name: string
    attrs: Record<string, unknown>
    children?: unknown[]
    getChild(name: string, ns?: string): ElementLike | undefined
  }
  export interface OutFacts { id: string; kind: QueryKind; to: string; dedupe: string | null }
  export interface InFacts { id: string; type: string }
  export function outboundFacts(stanza: ElementLike): OutFacts | null
  export function inboundReplyFacts(stanza: ElementLike): InFacts | null
  ```

`ElementLike` rather than ltx's `Element`: the classifier is pure, the app's tests construct
literals, and a real `Element` satisfies it structurally.

`dedupe` is the whole judgement of the redundancy detector, so it lives here where it can be tested
in isolation. A `null` dedupe means "a repeat of this is legitimate" — MAM re-queries the same
archive with a different window on purpose, and a roster fetch after a reconnect is not a bug.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { outboundFacts, inboundReplyFacts, type ElementLike } from './stanzaFacts'

function el(
  name: string,
  attrs: Record<string, unknown> = {},
  children: ElementLike[] = [],
): ElementLike {
  return {
    name,
    attrs,
    children,
    getChild(childName: string, ns?: string) {
      return children.find(
        (c) => c.name === childName && (ns === undefined || c.attrs.xmlns === ns),
      )
    },
  }
}

describe('outboundFacts', () => {
  it('classifies a disco#info query and makes it dedupable', () => {
    const iq = el('iq', { type: 'get', to: 'example.com', id: 'q1' }, [
      el('query', { xmlns: 'http://jabber.org/protocol/disco#info' }),
    ])
    expect(outboundFacts(iq)).toEqual({
      id: 'q1',
      kind: 'disco-info',
      to: 'example.com',
      dedupe: 'disco-info|example.com|',
    })
  })

  it('separates two disco#info queries for different nodes', () => {
    const withNode = el('iq', { type: 'get', to: 'example.com', id: 'q2' }, [
      el('query', { xmlns: 'http://jabber.org/protocol/disco#info', node: 'urn:x:caps#v1' }),
    ])
    expect(outboundFacts(withNode)?.dedupe).toBe('disco-info|example.com|urn:x:caps#v1')
  })

  it('refuses to call a MAM page redundant', () => {
    const iq = el('iq', { type: 'set', to: 'a@example.com', id: 'q3' }, [
      el('query', { xmlns: 'urn:xmpp:mam:2' }),
    ])
    const facts = outboundFacts(iq)
    // Paging queries the same archive on purpose; a shared dedupe key would report
    // every second page as a redundant query.
    expect(facts?.kind).toBe('mam')
    expect(facts?.dedupe).toBeNull()
  })

  it('ignores messages, presence and IQ replies', () => {
    expect(outboundFacts(el('message', { to: 'a@example.com', id: 'm1' }))).toBeNull()
    expect(outboundFacts(el('presence', { id: 'p1' }))).toBeNull()
    expect(outboundFacts(el('iq', { type: 'result', id: 'r1', to: 'a@example.com' }))).toBeNull()
  })

  it('ignores an IQ with no id, which could never be paired', () => {
    const iq = el('iq', { type: 'get', to: 'example.com' }, [
      el('query', { xmlns: 'http://jabber.org/protocol/disco#info' }),
    ])
    expect(outboundFacts(iq)).toBeNull()
  })

  it('keys a query with no target on the empty string, which is the server', () => {
    const iq = el('iq', { type: 'get', id: 'q4' }, [
      el('query', { xmlns: 'jabber:iq:roster' }),
    ])
    expect(outboundFacts(iq)).toEqual({ id: 'q4', kind: 'roster', to: '', dedupe: null })
  })
})

describe('inboundReplyFacts', () => {
  it('reports a result and an error alike', () => {
    expect(inboundReplyFacts(el('iq', { type: 'result', id: 'q1' }))).toEqual({
      id: 'q1',
      type: 'result',
    })
    expect(inboundReplyFacts(el('iq', { type: 'error', id: 'q1' }))).toEqual({
      id: 'q1',
      type: 'error',
    })
  })

  it('ignores an inbound request, which answers nothing', () => {
    expect(inboundReplyFacts(el('iq', { type: 'get', id: 'srv-1' }))).toBeNull()
    expect(inboundReplyFacts(el('message', { id: 'm1' }))).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/fluux && npx vitest run src/anomaly/detectors/stanzaFacts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the classifier**

```typescript
/**
 * What an anomaly detector may know about a stanza.
 *
 * Structural rather than ltx-typed: the classifier is pure, and a real `Element`
 * satisfies this shape. Nothing here reaches a record — the app tokenizes `to` at
 * the recorder boundary, and `kind` becomes a closed TAG constant.
 *
 * @module Anomaly/Detectors/StanzaFacts
 */

export type QueryKind =
  | 'disco-info'
  | 'disco-items'
  | 'vcard'
  | 'avatar'
  | 'mam'
  | 'roster'
  | 'other'

export interface ElementLike {
  name: string
  attrs: Record<string, unknown>
  children?: unknown[]
  getChild(name: string, ns?: string): ElementLike | undefined
}

export interface OutFacts {
  id: string
  kind: QueryKind
  /** Bare or full JID as addressed; empty string means the account's own server. */
  to: string
  /**
   * Identity for the redundancy check, or `null` when a repeat is legitimate.
   */
  dedupe: string | null
}

export interface InFacts {
  id: string
  type: string
}

const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info'
const NS_DISCO_ITEMS = 'http://jabber.org/protocol/disco#items'
const NS_VCARD = 'vcard-temp'
const NS_MAM = 'urn:xmpp:mam:2'
const NS_ROSTER = 'jabber:iq:roster'
const NS_PUBSUB = 'http://jabber.org/protocol/pubsub'
const AVATAR_NODES = new Set(['urn:xmpp:avatar:data', 'urn:xmpp:avatar:metadata'])

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function childNamespace(stanza: ElementLike): { ns: string; node: string } {
  for (const raw of stanza.children ?? []) {
    const child = raw as ElementLike | undefined
    if (!child || typeof child !== 'object' || typeof child.name !== 'string') continue
    const ns = str(child.attrs?.xmlns)
    if (ns) return { ns, node: str(child.attrs?.node) }
  }
  return { ns: '', node: '' }
}

function classify(ns: string, node: string): QueryKind {
  switch (ns) {
    case NS_DISCO_INFO:
      return 'disco-info'
    case NS_DISCO_ITEMS:
      return 'disco-items'
    case NS_VCARD:
      return 'vcard'
    case NS_MAM:
      return 'mam'
    case NS_ROSTER:
      return 'roster'
    case NS_PUBSUB:
      return AVATAR_NODES.has(node) ? 'avatar' : 'other'
    default:
      return 'other'
  }
}

/**
 * Which kinds are judged for redundancy.
 *
 * A MAM query pages through one archive with a different window each time, and a
 * roster or generic IQ has no stable identity a repeat could be measured against.
 * Giving either a dedupe key would report ordinary traffic as an anomaly — the one
 * outcome that costs this log its credibility.
 */
const DEDUPABLE: ReadonlySet<QueryKind> = new Set<QueryKind>([
  'disco-info',
  'disco-items',
  'vcard',
  'avatar',
])

export function outboundFacts(stanza: ElementLike): OutFacts | null {
  if (stanza.name !== 'iq') return null
  const type = str(stanza.attrs.type)
  if (type !== 'get' && type !== 'set') return null
  const id = str(stanza.attrs.id)
  if (!id) return null

  const { ns, node } = childNamespace(stanza)
  const kind = classify(ns, node)
  const to = str(stanza.attrs.to)
  return {
    id,
    kind,
    to,
    dedupe: DEDUPABLE.has(kind) ? `${kind}|${to}|${node}` : null,
  }
}

export function inboundReplyFacts(stanza: ElementLike): InFacts | null {
  if (stanza.name !== 'iq') return null
  const type = str(stanza.attrs.type)
  if (type !== 'result' && type !== 'error') return null
  const id = str(stanza.attrs.id)
  if (!id) return null
  return { id, type }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/fluux && npx vitest run src/anomaly/detectors/stanzaFacts.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/anomaly/detectors/stanzaFacts.ts apps/fluux/src/anomaly/detectors/stanzaFacts.test.ts
git commit -m "feat(anomaly): classify an outbound IQ into a closed set of query kinds"
```

---

### Task 4: Register the two ids

**Files:**
- Modify: `apps/fluux/src/anomaly/values.ts`
- Modify: `docs/ANOMALY_INVARIANTS.md`
- Test: `apps/fluux/src/anomaly/values.test.ts` (existing parity test must pass unchanged)

**Interfaces:**
- Produces: `ID.redundantQuery`, `ID.iqUnanswered`, `CTX.target`, and the `TAG.q*` query-kind
  constants, plus `queryKindTag(kind: QueryKind): Opaque`.

- [ ] **Step 1: Run the parity test first, to see it pass before the change**

Run: `cd apps/fluux && npx vitest run src/anomaly/values.test.ts`
Expected: PASS. This is the control: it must fail in Step 3 for the right reason.

- [ ] **Step 2: Add the constants**

In `values.ts`, extend `TAG` (query kinds), `ID`, and `CTX`:

```typescript
  // Outbound query kinds. A namespace is free text of exactly the sort the
  // registries keep out of a record, so it becomes a constant here.
  qDiscoInfo: mint('q:disco-info', 'tag'),
  qDiscoItems: mint('q:disco-items', 'tag'),
  qVcard: mint('q:vcard', 'tag'),
  qAvatar: mint('q:avatar', 'tag'),
  qMam: mint('q:mam', 'tag'),
  qRoster: mint('q:roster', 'tag'),
  qOther: mint('q:other', 'tag'),
```

```typescript
  redundantQuery: mint('xmpp-traffic/redundant-query', 'id'),
  iqUnanswered: mint('xmpp-traffic/iq-unanswered', 'id'),
```

```typescript
  /** The queried entity, as an entity token — never the JID. */
  target: mint('target', 'ctx'),
```

`CTX.query` already exists and carries the query-kind TAG; do not mint a second key for it.

Then, below the `TAG` block, the mapping the detector needs:

```typescript
/**
 * The TAG for a query kind.
 *
 * A total function over the union rather than a lookup that can miss: an unmapped
 * kind would otherwise reach a record as `undefined` and be dropped by the
 * serializer, losing the record rather than the field.
 */
export function queryKindTag(kind: QueryKind): Opaque {
  switch (kind) {
    case 'disco-info': return TAG.qDiscoInfo
    case 'disco-items': return TAG.qDiscoItems
    case 'vcard': return TAG.qVcard
    case 'avatar': return TAG.qAvatar
    case 'mam': return TAG.qMam
    case 'roster': return TAG.qRoster
    case 'other': return TAG.qOther
  }
}
```

Import `QueryKind` as a type from `./detectors/stanzaFacts`.

- [ ] **Step 3: Run the parity test and watch it fail**

Run: `cd apps/fluux && npx vitest run src/anomaly/values.test.ts`
Expected: FAIL — `ID` has entries with no row in `docs/ANOMALY_INVARIANTS.md`.

- [ ] **Step 4: Write the registry rows**

In `docs/ANOMALY_INVARIANTS.md`, replace the `### \`xmpp-traffic/\`` placeholder line
(`_(stage 5: ...)_`) with the shipped table, keeping `mam-page-yield` named as still to come:

```markdown
### `xmpp-traffic/`

| id | sev | Meaning | What to do |
|---|---|---|---|
| `xmpp-traffic/redundant-query` | suspect | The same disco, vCard or avatar query was sent to `ctx.target` again `ctx.elapsedMs` after the previous one had already been answered. `observed` is how many times it was sent inside the window, `expected` is 1 | A cache that is not being consulted, or a caller re-querying on every presence. `ctx.query` names the kind |
| `xmpp-traffic/iq-unanswered` | bug | An outbound application IQ went `observed` ms with no reply (`expected` is the threshold). `ctx.query` names the kind, `ctx.target` the entity | The peer or server never answered. Correlate with the connection crumbs: a reply lost across a reconnect is cleared rather than reported |

**Named non-cases:**

- Neither id sees connection-level traffic. The keepalive ping and the Stream Management `<r/>`
  bypass the application layer, so a stalled ping is invisible here by construction.
- `redundant-query` never judges MAM or roster traffic. MAM pages the same archive with a different
  window on purpose, and a roster fetch after a reconnect is expected.
- `redundant-query` requires the previous query to have been **answered**. A re-query after an error
  or a timeout is a retry, not a redundancy.
- `iq-unanswered` is cleared on disconnect and on reconnect. Everything in flight when a connection
  drops is unanswerable through no fault of the app.
- An IQ whose transport write failed is still reported as outbound. The seam reports the hand-off,
  not the socket; the connection reset that follows clears the pending entry.

_(stage 5 continued with MAM merge yield, which needed the archive-merge outcome seam)_
```

- [ ] **Step 5: Run the parity test and watch it pass**

Run: `cd apps/fluux && npx vitest run src/anomaly/values.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/anomaly/values.ts docs/ANOMALY_INVARIANTS.md
git commit -m "feat(anomaly): register the two xmpp-traffic invariants"
```

---

### Task 5: The traffic detector

**Files:**
- Create: `apps/fluux/src/anomaly/detectors/xmppTraffic.ts`
- Test: `apps/fluux/src/anomaly/detectors/xmppTraffic.test.ts`

**Interfaces:**
- Consumes: `OutFacts`, `InFacts` (Task 3); `ID`, `CTX`, `queryKindTag`, `tokenSync` (Task 4).
- Produces:
  ```typescript
  export interface TrafficDetector {
    observeOut(facts: OutFacts, now: number): void
    observeIn(facts: InFacts, now: number): void
    sweep(now: number): void
    reset(): void
  }
  export function createTrafficDetector(opts: {
    record: (input: RecordInput) => void
    token: (jid: string) => Opaque
    redundantWindowMs?: number
    unansweredMs?: number
    maxTracked?: number
  }): TrafficDetector
  ```

Pure and clock-injected, like the other detectors: it decides, and `install.ts` wires it.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createTrafficDetector } from './xmppTraffic'
import type { OutFacts } from './stanzaFacts'
import { CTX, ID, TAG } from '../values'
import type { RecordInput } from '../recorder'

const TOKEN = TAG.focus // any minted Opaque; identity is all the detector needs

function discoTo(jid: string, id: string): OutFacts {
  return { id, kind: 'disco-info', to: jid, dedupe: `disco-info|${jid}|` }
}

function setup(overrides: Partial<Parameters<typeof createTrafficDetector>[0]> = {}) {
  const records: RecordInput[] = []
  const detector = createTrafficDetector({
    record: (input) => records.push(input),
    token: () => TOKEN,
    ...overrides,
  })
  return { detector, records }
}

describe('redundant-query', () => {
  it('fires when an answered query is repeated inside the window', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 5_000)

    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(ID.redundantQuery)
    expect(records[0].sev).toBe('suspect')
    expect(records[0].expected).toBe(1)
    expect(records[0].observed).toBe(2)
    expect(records[0].ctx).toEqual(
      expect.arrayContaining([[CTX.elapsedMs, 4_900], [CTX.query, TAG.qDiscoInfo]]),
    )
  })

  it('stays silent once the window has passed', () => {
    const { detector, records } = setup({ redundantWindowMs: 60_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 61_000)

    expect(records).toEqual([])
  })

  it('treats a re-query after an error as a retry, not a redundancy', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'error' }, 100)
    detector.observeOut(discoTo('example.com', 'q2'), 1_000)

    expect(records).toEqual([])
  })

  it('separates two targets', () => {
    const { detector, records } = setup()
    detector.observeOut(discoTo('a.example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 10)
    detector.observeOut(discoTo('b.example.com', 'q2'), 20)

    expect(records).toEqual([])
  })

  it('never judges a query with no dedupe key', () => {
    const { detector, records } = setup()
    const mam: OutFacts = { id: 'm1', kind: 'mam', to: 'a@example.com', dedupe: null }
    detector.observeOut(mam, 0)
    detector.observeIn({ id: 'm1', type: 'result' }, 10)
    detector.observeOut({ ...mam, id: 'm2' }, 20)

    expect(records).toEqual([])
  })
})

describe('iq-unanswered', () => {
  it('fires once the threshold passes with no reply', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)

    detector.sweep(29_000)
    expect(records).toEqual([])

    detector.sweep(30_001)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(ID.iqUnanswered)
    expect(records[0].sev).toBe('bug')
    expect(records[0].expected).toBe(30_000)
    expect(records[0].observed).toBe(30_001)
  })

  it('reports one pending IQ once, not on every sweep', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.sweep(31_000)
    detector.sweep(45_000)

    expect(records).toHaveLength(1)
  })

  it('stays silent when the reply arrives in time', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.observeIn({ id: 'q1', type: 'result' }, 500)
    detector.sweep(60_000)

    expect(records).toEqual([])
  })

  it('forgets everything in flight when the connection resets', () => {
    const { detector, records } = setup({ unansweredMs: 30_000 })
    detector.observeOut(discoTo('example.com', 'q1'), 0)
    detector.reset()
    detector.sweep(60_000)

    expect(records).toEqual([])
  })

  it('bounds what it tracks', () => {
    const { detector, records } = setup({ unansweredMs: 30_000, maxTracked: 2 })
    detector.observeOut(discoTo('a.example.com', 'q1'), 0)
    detector.observeOut(discoTo('b.example.com', 'q2'), 1)
    detector.observeOut(discoTo('c.example.com', 'q3'), 2)
    detector.sweep(40_000)

    // The oldest was evicted rather than retained: a leak in a detector is worse
    // than a missed record.
    expect(records).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/fluux && npx vitest run src/anomaly/detectors/xmppTraffic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the detector**

```typescript
/**
 * The two invariants observable from the outbound application stanza seam.
 *
 * `redundant-query` says a query already answered was asked again inside a window;
 * `iq-unanswered` says a request was never answered at all. Both are pure and
 * clock-injected: `install.ts` supplies the stanzas, the clock and the sink.
 *
 * @module Anomaly/Detectors/XmppTraffic
 */
import type { RecordInput } from '../recorder'
import { CTX, ID, queryKindTag, type Opaque } from '../values'
import type { InFacts, OutFacts } from './stanzaFacts'

const REDUNDANT_WINDOW_MS = 60_000
const UNANSWERED_MS = 30_000
/**
 * How many requests and answered keys are remembered.
 *
 * A detector that grows without bound is a leak reported as a diagnostic. Evicting
 * the oldest entry loses a record; keeping everything loses the session.
 */
const MAX_TRACKED = 200

export interface TrafficDetector {
  observeOut(facts: OutFacts, now: number): void
  observeIn(facts: InFacts, now: number): void
  /** Report requests that have now been pending too long. */
  sweep(now: number): void
  /** Forget everything: a connection boundary makes every pending request moot. */
  reset(): void
}

export interface TrafficOptions {
  record: (input: RecordInput) => void
  /** Tokenizes a JID at the recorder boundary. Never the raw value. */
  token: (jid: string) => Opaque
  redundantWindowMs?: number
  unansweredMs?: number
  maxTracked?: number
}

interface Pending {
  facts: OutFacts
  at: number
}

function evictOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}

export function createTrafficDetector(opts: TrafficOptions): TrafficDetector {
  const redundantWindowMs = opts.redundantWindowMs ?? REDUNDANT_WINDOW_MS
  const unansweredMs = opts.unansweredMs ?? UNANSWERED_MS
  const maxTracked = opts.maxTracked ?? MAX_TRACKED

  /** Requests still waiting for a reply, keyed by stanza id. */
  const pending = new Map<string, Pending>()
  /** When each dedupable query was last ANSWERED, and how many were sent since. */
  const answered = new Map<string, { at: number; sent: number }>()

  return {
    observeOut(facts, now) {
      pending.set(facts.id, { facts, at: now })
      evictOldest(pending, maxTracked)

      if (!facts.dedupe) return
      const previous = answered.get(facts.dedupe)
      if (!previous) return
      const elapsed = now - previous.at
      if (elapsed > redundantWindowMs) {
        answered.delete(facts.dedupe)
        return
      }
      previous.sent++
      opts.record({
        id: ID.redundantQuery,
        sev: 'suspect',
        expected: 1,
        observed: previous.sent,
        ctx: [
          [CTX.query, queryKindTag(facts.kind)],
          [CTX.target, opts.token(facts.to)],
          [CTX.elapsedMs, elapsed],
        ],
      })
    },

    observeIn(facts, now) {
      const request = pending.get(facts.id)
      if (!request) return
      pending.delete(facts.id)
      // Only a RESULT establishes that the answer is now known. An error leaves the
      // caller with nothing cached, so its retry is not a redundancy.
      if (facts.type !== 'result' || !request.facts.dedupe) return
      answered.set(request.facts.dedupe, { at: now, sent: 1 })
      evictOldest(answered, maxTracked)
    },

    sweep(now) {
      for (const [id, request] of pending) {
        const elapsed = now - request.at
        if (elapsed <= unansweredMs) continue
        // Deleted as it is reported: the record says it went unanswered, and a
        // second report of the same request would say nothing new.
        pending.delete(id)
        opts.record({
          id: ID.iqUnanswered,
          sev: 'bug',
          expected: unansweredMs,
          observed: elapsed,
          ctx: [
            [CTX.query, queryKindTag(request.facts.kind)],
            [CTX.target, opts.token(request.facts.to)],
          ],
        })
      }
    },

    reset() {
      pending.clear()
      answered.clear()
    },
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/fluux && npx vitest run src/anomaly/detectors/xmppTraffic.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/anomaly/detectors/xmppTraffic.ts apps/fluux/src/anomaly/detectors/xmppTraffic.test.ts
git commit -m "feat(anomaly): detect redundant and unanswered application IQs"
```

---

### Task 6: Wire the detector to the client

**Files:**
- Modify: `apps/fluux/src/anomaly/install.ts`
- Modify: `apps/fluux/src/anomaly/AnomalyInstaller.tsx`
- Test: `apps/fluux/src/anomaly/install.test.ts`

**Interfaces:**
- Consumes: `createTrafficDetector` (Task 5), `outboundFacts` / `inboundReplyFacts` (Task 3),
  `client.onApplicationStanzaOut` (Task 1).
- Produces: `install(client?: TrafficClient)` where
  ```typescript
  interface TrafficClient {
    onApplicationStanzaOut(handler: (stanza: ElementLike) => void): () => void
    onStanza(handler: (stanza: ElementLike) => void): () => void
    on(event: 'offline' | 'reconnecting', handler: () => void): () => void
  }
  ```

A structural parameter type, not `XMPPClient`: `install.ts` must stay testable without constructing
a client, and the app's SDK mock does not carry one.

The client is optional so the existing call sites and every current test keep working; when it is
absent the traffic detector simply does not attach.

- [ ] **Step 1: Write the failing test**

Append to `apps/fluux/src/anomaly/install.test.ts`:

```typescript
describe('traffic detector wiring', () => {
  it('pairs an outbound IQ with its reply through the client seams', () => {
    const out: Array<(s: ElementLike) => void> = []
    const inbound: Array<(s: ElementLike) => void> = []
    const client = {
      onApplicationStanzaOut: (h: (s: ElementLike) => void) => { out.push(h); return () => {} },
      onStanza: (h: (s: ElementLike) => void) => { inbound.push(h); return () => {} },
      on: () => () => {},
    }

    const release = install(client)

    expect(out).toHaveLength(1)
    expect(inbound).toHaveLength(1)

    release()
  })

  it('detaches the client subscriptions when the last hold is released', () => {
    const offs: string[] = []
    const client = {
      onApplicationStanzaOut: () => () => offs.push('out'),
      onStanza: () => () => offs.push('in'),
      on: () => () => offs.push('conn'),
    }

    install(client)()

    expect(offs).toEqual(expect.arrayContaining(['out', 'in', 'conn']))
  })
})
```

Import `type ElementLike` from `./detectors/stanzaFacts` at the top of the test file.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/fluux && npx vitest run src/anomaly/install.test.ts`
Expected: FAIL — `install()` takes no arguments, so nothing subscribes.

- [ ] **Step 3: Wire it in `install.ts`**

Add the imports:

```typescript
import { createTrafficDetector, type TrafficDetector } from './detectors/xmppTraffic'
import { inboundReplyFacts, outboundFacts, type ElementLike } from './detectors/stanzaFacts'
import { tokenSync } from './values'
```

Declare the module-level handle beside the other attachment state:

```typescript
let trafficDetector: TrafficDetector | null = null
let clientUnsubscribes: (() => void) | null = null
```

Add the structural client type near `ProbeWindow`:

```typescript
/**
 * What the traffic detector needs from the client.
 *
 * Structural rather than `XMPPClient`: this module is unit-tested without a client,
 * and the app's SDK mock does not construct one.
 */
export interface TrafficClient {
  onApplicationStanzaOut(handler: (stanza: ElementLike) => void): () => void
  onStanza(handler: (stanza: ElementLike) => void): () => void
  on(event: 'offline' | 'reconnecting', handler: () => void): () => void
}
```

Inside the `attachRefs === 1` block, after the store subscriptions:

```typescript
    if (client) {
      const traffic = createTrafficDetector({
        record: (input) => rec.record(input),
        token: (jid) => tokenSync('jid', jid),
      })
      trafficDetector = traffic

      const offOut = client.onApplicationStanzaOut((stanza) => {
        const facts = outboundFacts(stanza)
        if (facts) traffic.observeOut(facts, Date.now())
      })
      const offIn = client.onStanza((stanza) => {
        const facts = inboundReplyFacts(stanza)
        if (facts) traffic.observeIn(facts, Date.now())
      })
      // A connection boundary makes every pending request unanswerable through no
      // fault of the app, and re-querying disco after a reconnect is correct.
      const offOffline = client.on('offline', () => traffic.reset())
      const offReconnecting = client.on('reconnecting', () => traffic.reset())
      clientUnsubscribes = () => {
        offOut()
        offIn()
        offOffline()
        offReconnecting()
      }
    }
```

Sweep from the existing sampler — `startDetectorTick`'s `onSample` already runs once a second and is
the only signal that says the app was alive at that instant:

```typescript
      onSample: (now) => {
        foregroundShare.sample(now)
        trafficDetector?.sweep(Date.now())
      },
```

Change the signature and release both in the release path and in `resetInstallForTesting`:

```typescript
export function install(client?: TrafficClient): () => void {
```

```typescript
    clientUnsubscribes?.()
    clientUnsubscribes = null
    trafficDetector = null
```

- [ ] **Step 4: Pass the client from the installer**

`apps/fluux/src/anomaly/AnomalyInstaller.tsx`:

```typescript
import { useEffect } from 'react'
import { useXMPPContext } from '@fluux/sdk'
import { install } from './install'

export default function AnomalyInstaller(): null {
  const { client } = useXMPPContext()
  useEffect(() => install(client), [client])
  return null
}
```

- [ ] **Step 5: Run the anomaly suite**

Run: `cd apps/fluux && npx vitest run src/anomaly`
Expected: PASS, including the two new wiring tests.

If `useXMPPContext` is not on the app's `@fluux/sdk` mock, add it there — a new SDK export used by
the app has to be present in the mock (project testing note).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/anomaly/install.ts apps/fluux/src/anomaly/AnomalyInstaller.tsx \
        apps/fluux/src/anomaly/install.test.ts
git commit -m "feat(anomaly): observe application IQ traffic from the client seam"
```

---

### Task 7: Prove a healthy session stays quiet

**Files:**
- Modify: `scripts/anomaly-smoke.ts`

**Interfaces:**
- Consumes: the ids from Task 4.

The smoke test already asserts that a healthy demo session fires **no** detector. Both new ids join
that set: a detector that fires on ordinary traffic is deleted rather than tuned, and this is where
that is caught before it reaches the log.

- [ ] **Step 1: Add the ids to the healthy-session assertion**

In `scripts/anomaly-smoke.ts`, in the `ids` set (around `:272`):

```typescript
        'xmpp-traffic/redundant-query',
        'xmpp-traffic/iq-unanswered',
```

- [ ] **Step 2: Run the smoke test**

Run: `npm run test:scroll -- anomaly-smoke` (or the project's Playwright entry point for
`scripts/anomaly-smoke.ts`; check `package.json` for the script that drives it)
Expected: PASS — the healthy demo session produces neither id.

If either fires, do not tune the threshold. Find out which ordinary path produced it and fix the
classification; a detector that fires during normal use is the one failure this design deletes a
detector for.

- [ ] **Step 3: Commit**

```bash
git add scripts/anomaly-smoke.ts
git commit -m "test(anomaly): hold the new traffic detectors to a silent healthy session"
```

---

### Task 8: Close the slice

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md` (§5.2 status)

- [ ] **Step 1: Mark the two ids shipped in the spec's catalogue**

In §5.2, mark `redundant-query` and `iq-unanswered` as shipped in stage 5a. The follow-up 5b plan
ships MAM merge yield as a rate. The registry owns the live contract; the spec's table only needs to
stop claiming the traffic detectors are unbuilt.

- [ ] **Step 2: Run the full verification**

```bash
npm test
npm run typecheck
npm run lint
npm run bench:seam -w @fluux/sdk
```

Expected: all green; the bench numbers go in the pull request body.

- [ ] **Step 3: Commit and open the pull request**

Use `$preflight-change` for the readiness verdict, then `$publish-change`. The pull request states
the measured per-stanza cost and names the coverage gap (connection-level sends are invisible).

---

## Self-review

**Spec coverage.** §5.5 seam 1 → Task 1. Hot-path budget and measurement → Tasks 1 and 2. §5.2
`redundant-query` and `iq-unanswered` → Tasks 3–6. §5.2 `mam-page-yield` → explicitly out of this
plan, deferred to 5b with the reason. §6.1 (a false-positive detector is deleted) → Task 7's control.
Privacy by construction (§4.4) → Task 4's `CTX.target` token and closed query-kind tags; no raw JID
or namespace can reach a record because `Scalar` admits no string.

**Placeholders.** None: every step carries the code or the exact command.

**Type consistency.** `OutFacts`/`InFacts`/`ElementLike`/`QueryKind` are defined in Task 3 and used
under those names in Tasks 4, 5 and 6. `createTrafficDetector` options match its call in Task 6.
`queryKindTag` is defined in Task 4 and consumed in Task 5. `CTX.query` is reused rather than
duplicated; `CTX.target` is new.
