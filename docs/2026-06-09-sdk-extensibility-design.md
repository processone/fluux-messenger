# SDK Extensibility & API Hardening — Design

**Status:** design proposal (2026-06-09) · **Origin:** [STRATEGIC_REVIEW.md](STRATEGIC_REVIEW.md) §4.1
**Timing constraint:** these are breaking or surface-defining changes — they should land
**before the first public release of `@fluux/sdk`**, while breaking changes are still free.

Four chantiers, ordered: (1) public module registration, (2) stop leaking `Element`,
(3) typed `error:*` events, (4) bot examples. They are independent and can ship separately.

---

## 1. Public module registration — `client.registerModule()`

### Today

The internals are already shaped for this. `BaseModule` (`src/core/modules/BaseModule.ts`)
is a chain-of-responsibility: each module implements `handle(stanza): boolean`, and
`XMPPClient` dispatches incoming stanzas through an ordered module list
(`XMPPClient.ts:682` — first module returning `true` consumes the stanza). Dependencies are
injected via `ModuleDependencies` (sendStanza, sendIQ, emit, emitSDK, stores…). The JSDoc on
`BaseModule` even documents "Creating a custom module" — but the class is `@internal` and
there is no way to register one without forking.

The E2EE plugin host (`client.e2ee.register(...)`) proves the registration pattern works.

### Proposal

```typescript
interface FluuxModule {
  /** Stable identifier, e.g. 'xep0184-receipts' */
  readonly name: string
  /** Called once, before connection. Receive the public module API surface. */
  init(ctx: ModuleContext): void
  /** Stanza chain, same contract as BaseModule.handle. Optional. */
  handle?(stanza: StanzaElement): boolean | void
  /** Lifecycle hooks. All optional. */
  onOnline?(info: { jid: string; resumed: boolean }): void
  onOffline?(): void
  dispose?(): void
}

client.registerModule(module: FluuxModule, opts?: { before?: string }): () => void
```

- `ModuleContext` is the **public** subset of `ModuleDependencies`: `sendStanza`, `sendIQ`,
  `getCurrentJid`, `emitSDK` (typed, see §3), plus `disco` helpers. Stores stay out —
  third-party modules publish state through events, apps decide where it lives.
- Ordering: custom modules run **before** built-ins by default (so they can claim stanzas
  the SDK would otherwise route), with `opts.before` for explicit placement. Built-in order
  is unchanged.
- Registration is allowed before connect and while online (`onOnline` fires immediately if
  already online). The returned function unregisters and calls `dispose`.
- Built-in modules migrate to this interface opportunistically, not in a big bang —
  `BaseModule` already matches `handle`; the constructor-injection difference is contained.

### First consumers (validation)

- **XEP-0184/0333 receipts/markers** — also a roadmap item; building it as a registered
  module (even if it ships in-tree) proves the API on a real feature.
- The **XEP-0077/0445 registration** module from the
  [invitation flow design](2026-06-09-invitation-flow-design.md).

---

## 2. Stop leaking `Element` — `StanzaElement` DTO

### Today

`export type { Element } from '@xmpp/client'` (`src/index.ts:376`) couples every SDK
consumer to ltx internals. `xml` builder is re-exported too. Public utilities
(`parseDataForm`, `getFallbackElement`, `onStanza`, console events…) traffic in raw
`Element`.

### Proposal

A minimal read-only interface, structurally compatible with ltx so the internal cast is
free:

```typescript
interface StanzaElement {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  getAttr(name: string): string | undefined
  getChild(name: string, xmlns?: string): StanzaElement | undefined
  getChildren(name: string, xmlns?: string): StanzaElement[]
  getText(): string
  toString(): string
}
```

- Public APIs (module `handle`, `onStanza`, data-form utils, console events) accept/return
  `StanzaElement`. Internally everything keeps using ltx — `Element` already satisfies the
  interface, so this is a type-level change at almost every call site.
- **Building** stanzas publicly: export a tiny `stanza(name, attrs, ...children)` factory
  wrapping `xml(...)` so consumers never import ltx. Same shape, our type.
- Remove the `Element` and `xml` re-exports from `src/index.ts`. Keep them available from
  `@fluux/sdk/internal` for one transition release if needed.

This is the single most important pre-publication break: once third parties type their
code against ltx `Element`, the coupling can never be removed cheaply.

---

## 3. Typed error events — `error:*`

### Today

35+ `.catch()` blocks log-and-swallow (MAM timeouts, IndexedDB quota, proxy failures,
avatar cache…). Apps and bots cannot observe failures: a MAM timeout looks identical to "no
new messages". The E2EE layer shows the right pattern (`E2EEPluginError` with
`kind: 'transient' | 'permanent'` + `code`).

### Proposal

One SDK event channel with a discriminated union, not 35 new events:

```typescript
type SDKErrorEvent =
  | { domain: 'mam';     code: 'timeout' | 'server-error'; context: { queryJid: string } }
  | { domain: 'cache';   code: 'quota-exceeded' | 'write-failed'; context: { store: string } }
  | { domain: 'proxy';   code: 'start-failed' | 'bridge-closed'; context: { reason?: string } }
  | { domain: 'upload';  code: 'slot-denied' | 'put-failed'; context: { filename: string } }
  // extensible — registered modules emit through the same channel
  | { domain: string;    code: string; context?: Record<string, unknown> }

client.on('sdk-error', (e: SDKErrorEvent) => { ... })
```

- Every silent `.catch()` keeps its local recovery behaviour but **also** emits.
  Conversion is mechanical and incremental; start with the four domains above.
- The app can then surface what UX_REVIEW §4 asks for (network banners, "history may be
  incomplete" notices) without new plumbing each time.

---

## 4. Bot story — examples and discoverability

Headless operation already works (no DOM dependency in core; vanilla Zustand stores), but
the entry point (`createDefaultStoreBindings`) is undiscoverable and there is no runnable
example, while CLAUDE.md claims bots as a primary use case.

- `examples/bot/echo-bot.ts` (~80 lines): connect, join a MUC, reply to mentions —
  runnable with `npx tsx`, no React anywhere.
- `examples/bot/notifier-bot.ts`: send-only bot (CI notifications) — shows the minimal
  store-less path.
- `docs/BOTS.md`: which bundle to import (`@fluux/sdk/core`), bindings explained in five
  lines, links to the examples.
- Once §1 lands, a third example registering a custom module becomes the extensibility
  showcase.

---

## Sequencing & release packaging

| Step | Item | Breaking? |
|---|---|---|
| 1 | `StanzaElement` DTO + remove ltx re-exports (§2) | **Yes** — do first |
| 2 | `sdk-error` channel (§3) | No — additive |
| 3 | `registerModule` (§1), validated on XEP-0184 receipts | No — additive |
| 4 | Bot examples + BOTS.md (§4) | No |

Steps 2–4 are additive and can ship in any minor release; step 1 defines the public type
vocabulary the others use (module `handle`, error contexts), which is why it goes first.
All four should be done before `@fluux/sdk` is published publicly (release date currently
tied to the product leaving beta).
