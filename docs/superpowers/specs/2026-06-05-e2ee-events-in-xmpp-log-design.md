# Surface E2EE key-lifecycle & failure events in the XMPP events log

- **Date:** 2026-06-05
- **Status:** Proposed (awaiting review)
- **Area:** `packages/fluux-sdk/src/stores/consoleStore.ts`, `packages/fluux-sdk/src/core/XMPPClient.ts`, `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts`, `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts`, `apps/fluux/src/components/XmppConsole.tsx`

## Problem

When a user reports "encryption broke" (red lock, garbled fallback body,
`[Encrypted message: could not decrypt]`), the diagnostics they can actually
send us contain **nothing** about E2EE:

- In production, `E2EEManager` is constructed without a `logger`
  ([XMPPClient.ts:1901](../../../packages/fluux-sdk/src/core/XMPPClient.ts)),
  so its logger defaults to `silentLogger`
  ([E2EEManager.ts:103](../../../packages/fluux-sdk/src/core/e2ee/E2EEManager.ts)).
  The **six existing `this.logger.*` call sites** (plugin registered/unregistered,
  pinned-strategy fallback, capability-probe failed, queued key-change) emit into
  a no-op.
- The single most useful event — **decrypt failure** — is logged via the
  standalone `logWarn`
  ([stanzaDecrypt.ts:229](../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts)),
  which reaches only the `[Fluux]` browser-console / Rust file log, **not** the
  in-app, filterable, exportable XMPP events log.
- Several key troubleshooting moments are not logged anywhere: **no mutual E2EE
  support** (`selectStrategy` → `null`), **peer key change** (PEP notice), trust
  transitions, and **encrypt failures**.

The in-app XMPP events log ([XmppConsole.tsx](../../../apps/fluux/src/components/XmppConsole.tsx))
already records connection/SM/presence/error events via
`consoleStore.addEvent(message, category)`, filters by category, and **exports to
a text file** users attach to bug reports. E2EE is the one major subsystem absent
from it.

## Goal

Make the "key lifecycle + failures" set of E2EE events appear in the in-app XMPP
events log (and, for free, the persistent `[Fluux]` file log), privacy-safe, so
that troubleshooting a remote user's E2EE issue from their exported log becomes
possible.

Scope was chosen explicitly: **key lifecycle + failures** — *not* a per-message
success line for every encrypt/decrypt (too noisy on busy conversations).

## Approach (chosen: "adapter logger into the existing `Logger` seam")

The SDK already has a `Logger` interface
([types.ts:361](../../../packages/fluux-sdk/src/core/e2ee/types.ts)) threaded
through `E2EEManager` and into every plugin via `ctx.logger`. We supply a concrete
implementation that the manager (and plugins) already know how to call. No new
event surface, no coupling of the headless e2ee core to a specific store.

Rejected alternatives:

- **Direct `consoleStore.addEvent` calls inside e2ee core** — couples the headless
  core to a concrete store, discards the `Logger` abstraction plugins depend on,
  and duplicates the existing `this.logger.*` calls.
- **Structured `e2ee:diagnostic` SDK events consumed by the app** — more plumbing
  than even connection/SM logging uses, and inconsistent with the rest of the
  console pipeline. Revisit only if diagnostics ever need a consumer other than
  the console.

## Design

### 1. New `'e2ee'` event category

- Add `'e2ee'` to the `category` union of `addEvent` and to the `eventCategory`
  field of `XmppPacket` in
  [consoleStore.ts:53](../../../packages/fluux-sdk/src/stores/consoleStore.ts)
  (and the interface at :22–33).
- Add `'e2ee'` to `FilterType` and the filter-chip row in
  [XmppConsole.tsx:15](../../../apps/fluux/src/components/XmppConsole.tsx) and
  [:551](../../../apps/fluux/src/components/XmppConsole.tsx). All E2EE events use
  this single category, so a user isolates the entire encryption timeline with one
  filter.

### 2. Fan-out diagnostic logger

A small adapter implementing `Logger`, built where the console store is already in
reach (`XMPPClient`, which holds `this.stores.console`). Each level fans out to
two sinks:

1. `this.stores.console.addEvent(msg, 'e2ee')` — the in-app, filterable,
   **exportable** log.
2. the existing module logger `logDebug/logInfo/logWarn/logError`
   ([logger.ts](../../../packages/fluux-sdk/src/core/logger.ts)) — the persistent
   `[Fluux]` Rust file log, captured even when the user never opens the console.

Injected at the existing construction site:

```ts
// XMPPClient.ts ~1901
this.e2ee = new E2EEManager({
  storage: this.e2eeStorageBackend,
  xmpp: this.buildE2EEPrimitives(),
  account: { jid: bareJid },
  logger: this.buildE2EEDiagnosticLogger(), // NEW
})
```

`buildE2EEDiagnosticLogger()` returns an object whose methods format a message and
write to both sinks. The logger captures `this.stores` by closure; if stores are
absent (e.g. headless SDK use without console binding) it falls through to the
module logger only. Mapping: `info`/`debug` → `logInfo`/`logDebug`,
`warn`/`error` → `logWarn`/`logError`; all four → `addEvent(msg, 'e2ee')`.

Injecting this alone lights up the six already-written `this.logger.*` calls.

### 3. Bring the decrypt path onto the same logger

`decryptStanzaInPlace` already receives `manager: E2EEManager`
([stanzaDecrypt.ts:120](../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts)).
Expose the manager's logger through a package-internal accessor (e.g.
`E2EEManager.getDiagnosticLogger(): Logger`) and migrate the two E2EE log calls in
`stanzaDecrypt` onto it:

- decrypt-failed ([:229](../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts))
- dropped-payload-child ([:282](../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts))

The standalone `logWarn`/`logDebug` calls there are **removed** — the adapter
already forwards to the module logger, so keeping both would double-log.
`logInfo` import in `stanzaDecrypt` is re-evaluated for remaining users.

### 4. Events logged (scope: key lifecycle + failures)

| Event | Site | Level | Status |
|---|---|---|---|
| Plugin registered / unregistered | E2EEManager [:147](../../../packages/fluux-sdk/src/core/e2ee/E2EEManager.ts) / [:179](../../../packages/fluux-sdk/src/core/e2ee/E2EEManager.ts) | info | exists → now visible |
| Pinned strategy unavailable, fell back | E2EEManager [:351](../../../packages/fluux-sdk/src/core/e2ee/E2EEManager.ts) | warn | exists → now visible |
| **No mutual E2EE support** (`selectStrategy` → `null`) | E2EEManager [:355](../../../packages/fluux-sdk/src/core/e2ee/E2EEManager.ts) | warn | **new** |
| Capability probe failed | E2EEManager [:384](../../../packages/fluux-sdk/src/core/e2ee/E2EEManager.ts) | warn | exists → now visible |
| Capability probe result (supported / not) | E2EEManager [:380](../../../packages/fluux-sdk/src/core/e2ee/E2EEManager.ts) | debug | **new** |
| **Peer key change** (PEP notice) | `notifyPeerKeysChanged` [:405](../../../packages/fluux-sdk/src/core/e2ee/E2EEManager.ts) | info | **new** |
| **Trust updated** (e.g. untrusted → tofu/verified) | `onSecurityContextUpdated` listener, XMPPClient [:1911](../../../packages/fluux-sdk/src/core/XMPPClient.ts) | info | **new** |
| **Decrypt failed** (+ reason; rejection vs retryable) | stanzaDecrypt [:227](../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts) | warn | migrate to logger |
| Dropped disallowed payload child | stanzaDecrypt [:282](../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts) | debug | migrate to logger |
| **Encrypt failed** | wrap `encryptOutbound` [:476](../../../packages/fluux-sdk/src/core/e2ee/E2EEManager.ts) in try / log / rethrow | warn | **new** |

For decrypt-failed, the message distinguishes the two dispositions the code
already computes ([stanzaDecrypt.ts:228](../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts)):
signature **rejection** (final) vs recoverable failure (stashed for deferred
retry). Where an `E2EEPluginError` is in hand, include its `code` slug (e.g.
`wrong-passphrase`, `key-locked`, `pep-unsupported`) and `kind`
(transient/permanent) from [errors.ts](../../../packages/fluux-sdk/src/core/e2ee/errors.ts).

### 5. Privacy (the one guardrail)

A redaction helper applied **at the call sites** (so the same string is safe for
the persistent/exported file log):

- `fpShort(fp)` → first 8 hex chars of a fingerprint, never the full fingerprint.
- Peer identifier → **domain only** via `getDomain(jid)`, honoring the existing
  `logger.ts` doctrine ("Never pass message bodies or JID local parts… use
  `getDomain(jid)` for 1:1"). Room JIDs (service addresses) may appear in full.
- **Never** log plaintext bodies, private key material, passphrases, or full
  ciphertext / encrypted payload XML.

Reason codes (`E2EEPluginError.code`) and protocol ids are safe and encouraged —
they carry the diagnostic signal without identifying content.

### 6. Testing

SDK unit tests (Vitest, pure where possible):

- A fake `Logger` (or console-store spy) asserts the correct
  `addEvent(msg, 'e2ee')` fires for: decrypt-failure (both rejection and
  retryable), no-mutual-support, peer-key-change, encrypt-failure.
- A **redaction test**: drive each logged event with a JID carrying a local part
  and a long fingerprint, and assert the emitted message contains neither the
  local part, the full fingerprint, nor any plaintext/passphrase.
- App test mock (`test-setup.ts`): if `getDomain`/any new SDK export is consumed
  by `XmppConsole`, ensure the `@fluux/sdk` mock includes it (spread
  `importOriginal`).

After SDK type/signature changes, rebuild the SDK (`npm run build:sdk`) before app
typecheck.

## Out of scope

- Per-message success logging (deliberately excluded — noise).
- A separate "E2EE diagnostics" export distinct from the existing XMPP log export.
- Changing the `[Fluux]` module logger's existing behavior or its other callers.
- Plugin-internal logging beyond what `ctx.logger` already affords (Web/Sequoia
  plugins may later add `ctx.logger.debug` at key-unlock; not required here).

## Risks / notes

- **Double-logging** if a migrated `stanzaDecrypt` call keeps its old `logWarn`
  alongside the manager logger — the adapter already fans out to the module
  logger. The migration must *replace*, not *add*.
- **Headless SDK use**: the logger must tolerate `this.stores` being unbound and
  degrade to the module-logger sink only.
- **Category churn in the console UI**: a new chip is additive; verify the
  existing "event" catch-all filter still behaves (E2EE entries are
  `type: 'event'` with `eventCategory: 'e2ee'`).
