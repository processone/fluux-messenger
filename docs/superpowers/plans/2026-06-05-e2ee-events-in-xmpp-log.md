# E2EE Events in XMPP Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface E2EE key-lifecycle and failure events (privacy-safe) in the in-app XMPP events log and the persistent `[Fluux]` file log, so a user's exported diagnostics reveal what the encryption layer did.

**Architecture:** A pure fan-out `Logger` adapter (`createE2EEDiagnosticLogger`) writes every E2EE log line to both `consoleStore.addEvent(msg, 'e2ee')` and the existing module logger (`logWarn`/etc.). It is injected into `E2EEManager` at construction (today the manager logs to a no-op `silentLogger`), which immediately lights up existing-but-dead `this.logger.*` calls. New log calls are added at the chosen lifecycle/failure points; the decrypt-failure log is migrated off the standalone module logger onto the manager's logger so it also reaches the in-app console. Every message carries an `[E2EE]` prefix and redacts peer JIDs to domain-only.

**Tech Stack:** TypeScript, Zustand vanilla stores, Vitest. Monorepo: `packages/fluux-sdk` (SDK) + `apps/fluux` (app).

**Scope (agreed):** Key lifecycle + failures. NOT per-message encrypt/decrypt success.

**Privacy guardrail (applies to every logged message):** peer identifiers are domain-only via `getDomain(jid)`; room JIDs (service addresses) may appear in full; NEVER log plaintext, private keys, passphrases, or ciphertext/encrypted-payload XML. Reason-code slugs (`E2EEPluginError.code`/`kind`) and protocol ids are safe and encouraged.

---

## File Structure

**Create:**
- `packages/fluux-sdk/src/core/e2eeDiagnosticLogger.ts` — pure factory turning a console sink + the module logger into the e2ee `Logger`. One responsibility: format (`[E2EE]` prefix) + fan-out.
- `packages/fluux-sdk/src/core/e2eeDiagnosticLogger.test.ts` — unit tests for the factory.
- `packages/fluux-sdk/src/stores/consoleStore.test.ts` — minimal test for the new `'e2ee'` category.

**Modify:**
- `packages/fluux-sdk/src/core/types/console.ts:32` — widen `eventCategory` union.
- `packages/fluux-sdk/src/stores/consoleStore.ts:53` — widen `addEvent` category param.
- `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts` — `getDiagnosticLogger()` accessor; new log calls (no-mutual-support, peer-key-change, encrypt-failed); redact peer in existing calls; new imports.
- `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts` — spy-logger helpers + tests for the new/redacted calls.
- `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts` — migrate decrypt-failed + dropped-child onto the manager's logger; domain-redact peer.
- `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts` — test the migrated logging + redaction.
- `packages/fluux-sdk/src/core/XMPPClient.ts:~1901` — build + inject the fan-out logger; add the trust-updated log in the `onSecurityContextUpdated` listener.

**Possibly modify (only if app typecheck/test demands):**
- `apps/fluux/src/test-setup.ts` — extend the `@fluux/sdk` mock if a newly-consumed export is referenced.

---

## Task 1: Widen the `eventCategory` union to include `'e2ee'`

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/console.ts:32`
- Modify: `packages/fluux-sdk/src/stores/consoleStore.ts:53`
- Test: `packages/fluux-sdk/src/stores/consoleStore.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/stores/consoleStore.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { consoleStore } from './consoleStore'

describe('consoleStore — e2ee event category', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    consoleStore.getState().clearEntries()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("accepts and stores the 'e2ee' event category", () => {
    consoleStore.getState().addEvent('[E2EE] decrypt failed for example.com', 'e2ee')
    // Entries are batched and flushed after BATCH_INTERVAL_MS (100ms).
    vi.advanceTimersByTime(100)
    const entries = consoleStore.getState().entries
    const last = entries[entries.length - 1]
    expect(last.type).toBe('event')
    expect(last.eventCategory).toBe('e2ee')
    expect(last.content).toBe('[E2EE] decrypt failed for example.com')
  })
})
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm run typecheck`
Expected: FAIL — TS error at the test's `addEvent(..., 'e2ee')`: `Argument of type '"e2ee"' is not assignable to parameter of type '"connection" | "error" | "sm" | "presence" | undefined'`.

- [ ] **Step 3: Widen the type unions**

In `packages/fluux-sdk/src/core/types/console.ts`, change the `eventCategory` field (line ~32):

```ts
  eventCategory?: 'connection' | 'error' | 'sm' | 'presence' | 'e2ee'
```

In `packages/fluux-sdk/src/stores/consoleStore.ts`, change the `addEvent` signature in the `ConsoleState` interface (line ~53):

```ts
  addEvent: (message: string, category?: 'connection' | 'error' | 'sm' | 'presence' | 'e2ee') => void
```

- [ ] **Step 4: Run typecheck and the test to verify they pass**

Run: `npm run typecheck`
Expected: PASS (no errors).

Run: `cd packages/fluux-sdk && npx vitest run src/stores/consoleStore.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/types/console.ts packages/fluux-sdk/src/stores/consoleStore.ts packages/fluux-sdk/src/stores/consoleStore.test.ts
git commit --no-gpg-sign -m "feat(console): add 'e2ee' event category"
```

---

## Task 2: Pure fan-out diagnostic logger factory

**Files:**
- Create: `packages/fluux-sdk/src/core/e2eeDiagnosticLogger.ts`
- Test: `packages/fluux-sdk/src/core/e2eeDiagnosticLogger.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/core/e2eeDiagnosticLogger.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createE2EEDiagnosticLogger } from './e2eeDiagnosticLogger'

describe('createE2EEDiagnosticLogger', () => {
  beforeEach(() => {
    // Module logger writes to console.* — silence to keep the suite stderr-clean.
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("writes to the sink with the 'e2ee' category and an [E2EE] prefix", () => {
    const events: { message: string; category?: string }[] = []
    const logger = createE2EEDiagnosticLogger({
      addEvent: (message, category) => events.push({ message, category }),
    })
    logger.warn('decrypt failed for example.com')
    expect(events).toHaveLength(1)
    expect(events[0].category).toBe('e2ee')
    expect(events[0].message).toBe('[E2EE] decrypt failed for example.com')
  })

  it('also forwards to the module logger (console)', () => {
    const logger = createE2EEDiagnosticLogger(undefined)
    logger.info('plugin registered: openpgp')
    expect(console.info).toHaveBeenCalledWith('[Fluux]', '[E2EE] plugin registered: openpgp')
  })

  it('tolerates an absent sink (headless SDK use)', () => {
    const logger = createE2EEDiagnosticLogger(undefined)
    expect(() => logger.debug('x')).not.toThrow()
  })

  it('appends an Error argument message', () => {
    const events: { message: string; category?: string }[] = []
    const logger = createE2EEDiagnosticLogger({
      addEvent: (message, category) => events.push({ message, category }),
    })
    logger.warn('probe failed openpgp example.com', new Error('timeout'))
    expect(events[0].message).toBe('[E2EE] probe failed openpgp example.com timeout')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2eeDiagnosticLogger.test.ts`
Expected: FAIL — `Cannot find module './e2eeDiagnosticLogger'`.

- [ ] **Step 3: Implement the factory**

Create `packages/fluux-sdk/src/core/e2eeDiagnosticLogger.ts`:

```ts
/**
 * Fan-out diagnostic logger for the E2EE subsystem.
 *
 * Turns a console-store sink plus the SDK module logger into the `Logger`
 * interface that `E2EEManager` (and, via `ctx.logger`, plugins) call. Every
 * line is prefixed with `[E2EE]` and written to BOTH:
 *   - the in-app, filterable, exportable XMPP events log (`addEvent`), and
 *   - the persistent `[Fluux]` console/Rust file log.
 *
 * **Privacy:** callers must pass already-redacted messages (domain-only peer
 * identifiers, no plaintext/keys/passphrases). This module only formats and
 * fans out — it does not redact.
 *
 * @module Core/E2EEDiagnosticLogger
 */
import type { Logger } from './e2ee/types'
import { logDebug, logInfo, logWarn, logError } from './logger'

type EventCategory = 'connection' | 'error' | 'sm' | 'presence' | 'e2ee'

/** Minimal slice of the console store this logger needs. */
export interface E2EEDiagnosticSink {
  addEvent(message: string, category?: EventCategory): void
}

const PREFIX = '[E2EE]'

/** Append safe (string / Error.message) extra args; drop objects. */
function format(message: string, args: unknown[]): string {
  const base = `${PREFIX} ${message}`
  if (args.length === 0) return base
  const extra = args
    .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
    .filter(Boolean)
    .join(' ')
  return extra ? `${base} ${extra}` : base
}

/**
 * Build the e2ee `Logger`. `sink` is the console store (or any object with a
 * compatible `addEvent`); pass `undefined` for headless use (module logger only).
 */
export function createE2EEDiagnosticLogger(sink?: E2EEDiagnosticSink): Logger {
  const emit = (moduleLog: (m: string) => void, message: string, args: unknown[]): void => {
    const line = format(message, args)
    moduleLog(line)
    sink?.addEvent(line, 'e2ee')
  }
  return {
    debug: (message, ...args) => emit(logDebug, message, args),
    info: (message, ...args) => emit(logInfo, message, args),
    warn: (message, ...args) => emit(logWarn, message, args),
    error: (message, ...args) => emit(logError, message, args),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2eeDiagnosticLogger.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/e2eeDiagnosticLogger.ts packages/fluux-sdk/src/core/e2eeDiagnosticLogger.test.ts
git commit --no-gpg-sign -m "feat(e2ee): fan-out diagnostic logger (console + file log)"
```

---

## Task 3: `getDiagnosticLogger()` accessor + shared spy-logger test helpers

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts` (add accessor near `getAccountJid`, ~line 112)
- Test: `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts`, add `Logger` to the type import from `./types`, then add these helpers near `makeManager` (top of file, after line 38) and a test:

```ts
// --- diagnostic-logger test helpers (added) ---
import type { Logger } from './types' // (fold into the existing type import block)

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  args: unknown[]
}
function makeSpyLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = []
  const rec =
    (level: LogCall['level']) =>
    (message: string, ...args: unknown[]) =>
      calls.push({ level, message, args })
  return {
    logger: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') },
    calls,
  }
}
function makeManagerWithLogger(logger: Logger): E2EEManager {
  return new E2EEManager({
    storage: new InMemoryStorageBackend(),
    xmpp: makeXmpp(),
    account: { jid: 'me@example.com' },
    logger,
  })
}

describe('E2EEManager — diagnostic logger', () => {
  it('exposes the injected logger via getDiagnosticLogger()', () => {
    const { logger } = makeSpyLogger()
    const manager = makeManagerWithLogger(logger)
    expect(manager.getDiagnosticLogger()).toBe(logger)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts -t "diagnostic logger"`
Expected: FAIL — `manager.getDiagnosticLogger is not a function`.

- [ ] **Step 3: Add the accessor**

In `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts`, add after `getAccountJid()` (~line 114):

```ts
  /**
   * The diagnostic logger this manager (and its plugins via `ctx.logger`)
   * write to. Exposed so the shared inbound-decrypt step
   * ({@link decryptStanzaInPlace}) can route its E2EE diagnostics through the
   * same fan-out logger instead of the standalone module logger.
   *
   * @internal
   */
  getDiagnosticLogger(): Logger {
    return this.logger
  }
```

(`Logger` is already imported at the top of this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts -t "diagnostic logger"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/E2EEManager.ts packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts
git commit --no-gpg-sign -m "feat(e2ee): expose getDiagnosticLogger() on E2EEManager"
```

---

## Task 4: Log "no mutual E2EE support" + add `getDomain`/target-label helper

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts` (imports; `selectStrategy` ~line 345; add `targetLabel` helper near `targetPeers` ~line 578)
- Test: `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `E2EEManager.test.ts`:

```ts
describe('E2EEManager — no mutual support logging', () => {
  it('warns (domain-only) when no plugin is mutually available', async () => {
    const { logger, calls } = makeSpyLogger()
    const manager = makeManagerWithLogger(logger)
    // A plugin the peer does NOT support.
    const plugin = new FakePlugin(weakDescriptor, 'urn:x:openpgp', {
      support: () => ({ supported: false, ttl: 60 }),
    })
    await manager.register(plugin)
    const result = await manager.selectStrategy({ kind: 'direct', peer: 'bob@chat.example.com' })
    expect(result).toBeNull()
    const warn = calls.find((c) => c.level === 'warn' && c.message.includes('no mutual E2EE support'))
    expect(warn).toBeDefined()
    // Privacy: domain only, never the local part.
    expect(warn!.message).toContain('chat.example.com')
    expect(warn!.message).not.toContain('bob@')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts -t "no mutual support"`
Expected: FAIL — no matching `warn` call.

- [ ] **Step 3: Implement**

In `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts` top imports, add:

```ts
import { getDomain } from '../jid'
import { isE2EEPluginError } from './errors'
```

Add a label helper next to `targetPeers` (~line 578):

```ts
/** Privacy-safe label for a conversation target: domain for 1:1, room JID for MUC. */
function targetLabel(target: ConversationTarget): string {
  return target.kind === 'direct' ? getDomain(target.peer) : target.room
}
```

In `selectStrategy` (~line 354), change the no-mutual branch:

```ts
    const mutual = await this.mutuallySupported(target)
    if (mutual.length === 0) {
      this.logger.warn(`no mutual E2EE support for ${targetLabel(target)}`)
      return null
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts -t "no mutual support"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/E2EEManager.ts packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts
git commit --no-gpg-sign -m "feat(e2ee): log no-mutual-support strategy selection (domain-only)"
```

---

## Task 5: Redact existing probe-failed warn + log peer key change

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts` (`peersAllSupport` ~line 384; `notifyPeerKeysChanged` ~line 405; `onPeerKeysChanged`-threw warn ~line 168; queued-change debug ~line 438)
- Test: `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `E2EEManager.test.ts`:

```ts
describe('E2EEManager — peer key change + probe redaction', () => {
  it('logs peer key change with domain only', async () => {
    const { logger, calls } = makeSpyLogger()
    const manager = makeManagerWithLogger(logger)
    manager.notifyPeerKeysChanged('alice@im.example.org', 'openpgp')
    const info = calls.find((c) => c.message.includes('peer key change'))
    expect(info).toBeDefined()
    expect(info!.message).toContain('im.example.org')
    expect(info!.message).not.toContain('alice@')
    expect(info!.message).toContain('openpgp')
  })

  it('redacts the peer in the capability-probe-failed warning', async () => {
    const { logger, calls } = makeSpyLogger()
    const manager = makeManagerWithLogger(logger)
    const plugin = new FakePlugin(weakDescriptor, 'urn:x:openpgp')
    plugin.probePeer = async () => {
      throw new Error('network down')
    }
    await manager.register(plugin)
    await manager.selectStrategy({ kind: 'direct', peer: 'carol@secret.example.net' })
    const warn = calls.find((c) => c.message.includes('Capability probe failed'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('secret.example.net')
    expect(warn!.message).not.toContain('carol@')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts -t "peer key change + probe redaction"`
Expected: FAIL — no `peer key change` log; probe-failed message still contains `carol@`.

- [ ] **Step 3: Implement**

In `peersAllSupport` (~line 384), redact the peer:

```ts
      } catch (err) {
        this.logger.warn(`Capability probe failed: ${plugin.descriptor.id} ${getDomain(peer)}`, err)
        return false
      }
```

In `notifyPeerKeysChanged` (~line 405), add an info log at the top of the method (before the cache invalidation):

```ts
  notifyPeerKeysChanged(peer: BareJID, protocolId?: string): void {
    this.logger.info(
      `peer key change for ${getDomain(peer)}${protocolId ? ` [${protocolId}]` : ''}`,
    )
    this.invalidateCapability(peer, protocolId)
    // ... unchanged ...
```

In the `onPeerKeysChanged` catch (~line 168), redact:

```ts
        this.logger.warn(`E2EE plugin ${id} onPeerKeysChanged(${getDomain(peer)}) threw`, err)
```

In `enqueuePendingPeerKeyChange` debug (~line 438), redact:

```ts
    this.logger.debug(
      `E2EE plugin ${protocolId} not yet registered; queued peer key-change for ${getDomain(peer)}`,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts -t "peer key change + probe redaction"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/E2EEManager.ts packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts
git commit --no-gpg-sign -m "feat(e2ee): log peer key change; redact peer JIDs in manager logs"
```

---

## Task 6: Log encrypt failure in `encryptOutbound`

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/E2EEManager.ts` (`encryptOutbound` ~line 468)
- Test: `packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `E2EEManager.test.ts`:

```ts
describe('E2EEManager — encrypt failure logging', () => {
  it('logs (domain-only, with code) and rethrows when encrypt fails', async () => {
    const { logger, calls } = makeSpyLogger()
    const manager = makeManagerWithLogger(logger)
    const plugin = new FakePlugin(weakDescriptor, 'urn:x:openpgp')
    plugin.encryptImpl = () => {
      throw new Error('boom')
    }
    await manager.register(plugin)
    await expect(
      manager.encryptOutbound({ kind: 'direct', peer: 'dave@vault.example.com' }, new Uint8Array([1])),
    ).rejects.toThrow('boom')
    const warn = calls.find((c) => c.level === 'warn' && c.message.includes('encrypt failed'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('vault.example.com')
    expect(warn!.message).not.toContain('dave@')
    expect(warn!.message).toContain('openpgp')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts -t "encrypt failure logging"`
Expected: FAIL — no `encrypt failed` warn (the error is thrown but not logged).

- [ ] **Step 3: Implement**

In `encryptOutbound` (~line 474), wrap the encrypt in a try/catch that logs then rethrows:

```ts
    const handle = await plugin.openConversation(target)
    try {
      const payload = await plugin.encrypt(handle, plaintext)
      return { plugin, payload }
    } catch (err) {
      const code = isE2EEPluginError(err) ? ` (${err.code}/${err.kind})` : ''
      this.logger.warn(`encrypt failed for ${targetLabel(target)} via ${plugin.descriptor.id}${code}`)
      throw err
    } finally {
      await plugin.closeConversation(handle).catch(() => {})
    }
```

(`isE2EEPluginError` and `targetLabel` were imported/added in Task 4.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/E2EEManager.test.ts -t "encrypt failure logging"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/E2EEManager.ts packages/fluux-sdk/src/core/e2ee/E2EEManager.test.ts
git commit --no-gpg-sign -m "feat(e2ee): log encrypt failures (domain-only, with error code)"
```

---

## Task 7: Migrate decrypt-path logging onto the manager's logger (domain-redacted)

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts` (imports; decrypt-failed ~line 229; dropped-child ~line 282)
- Test: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts` (it already imports `decryptStanzaInPlace`, `E2EEManager`, `InMemoryStorageBackend`, `xml`, and `FakeE2EEPlugin` with a configurable plugin). Add a spy-logger helper and a test. The `FakeE2EEPlugin` decrypt must be made to throw — add a `decryptThrows` flag to it if not present (see Step 3 note), or use the existing throwing path:

```ts
import type { Logger } from './types' // fold into existing type import

function makeSpyLogger(): { logger: Logger; calls: { level: string; message: string }[] } {
  const calls: { level: string; message: string }[] = []
  const rec = (level: string) => (message: string) => calls.push({ level, message })
  return {
    logger: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') },
    calls,
  }
}

describe('decryptStanzaInPlace — failure logging routes through the manager logger', () => {
  it('warns via the diagnostic logger with domain only on decrypt failure', async () => {
    const { logger, calls } = makeSpyLogger()
    const manager = new E2EEManager({
      storage: new InMemoryStorageBackend(),
      xmpp: makeXmpp(),
      account: { jid: 'me@example.com' },
      logger,
    })
    const plugin = new FakeE2EEPlugin(undefined)
    plugin.failDecrypt = true // see Step 3
    await manager.register(plugin)

    const stanza = xml(
      'message',
      { from: 'eve@private.example.org/res', id: 'm1' },
      xml('enc', { xmlns: TEST_NAMESPACE }, 'ciphertext'),
    ) as unknown as Element
    await decryptStanzaInPlace(stanza, manager, 'eve@private.example.org', 'live')

    const warn = calls.find((c) => c.level === 'warn' && c.message.includes('decrypt failed'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('private.example.org')
    expect(warn!.message).not.toContain('eve@')
  })
})
```

Note: `makeXmpp` may not exist in this test file — if absent, inline the minimal `XMPPPrimitives` object from `E2EEManager.test.ts` (the `makeXmpp` body) at the top of this test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts -t "routes through the manager logger"`
Expected: FAIL — either `FakeE2EEPlugin` has no `failDecrypt`, or the warn went to the module logger (`logWarn`) instead of the injected spy. Confirm the assertion on `calls` fails.

- [ ] **Step 3: Implement**

First, ensure `FakeE2EEPlugin` in the test can throw on decrypt. If it lacks a switch, add a public field and honor it in its `decrypt` method:

```ts
class FakeE2EEPlugin implements E2EEPlugin {
  // ... existing ...
  public failDecrypt = false
  // inside decrypt():
  //   if (this.failDecrypt) throw new Error('decrypt boom')
}
```

Then in `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts`:

- Update imports (line 27-28): add `getDomain`, drop now-unused module loggers if they are no longer referenced anywhere else in the file:

```ts
import { getBareJid, getDomain } from '../jid'
// Remove logWarn/logDebug from the '../logger' import IF this file no longer
// uses them after the migration below. Keep logInfo only if still referenced.
```

(Check remaining references before deleting an import — `grep -n "logWarn\|logDebug\|logInfo" stanzaDecrypt.ts`.)

- Replace the decrypt-failed log (line ~229):

```ts
    const isRejection = securityContext?.trust === 'rejected'
    manager
      .getDiagnosticLogger()
      .warn(
        `decrypt failed from ${getDomain(senderPeer)} (${isRejection ? 'rejected: invalid signature' : 'retryable'}): ${failureReason}`,
      )
```

- Replace the dropped-child log (line ~282):

```ts
          manager
            .getDiagnosticLogger()
            .debug(`dropped disallowed payload child <${(child as Element).name}> from ${getDomain(senderPeer)}`)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts
git commit --no-gpg-sign -m "feat(e2ee): route decrypt-path diagnostics through the fan-out logger (domain-only)"
```

---

## Task 8: Inject the fan-out logger in XMPPClient + log trust updates

**Files:**
- Modify: `packages/fluux-sdk/src/core/XMPPClient.ts` (import; `ensureE2EEManager` ~line 1889-1933)

- [ ] **Step 1: Add the import**

At the top of `packages/fluux-sdk/src/core/XMPPClient.ts` (with the other `./` imports), add:

```ts
import { createE2EEDiagnosticLogger } from './e2eeDiagnosticLogger'
import { getDomain } from './jid'
```

(If `getDomain` is already imported in this file, skip the second line.)

- [ ] **Step 2: Build + inject the logger and add the trust-updated log**

In `ensureE2EEManager` (~line 1901), build the logger once and pass it in, then use it in the security-context listener. **Use a late-bound sink** — pass a wrapper that reads `this.stores?.console` at call time, not the value captured at construction (the store binding may be established after `ensureE2EEManager` runs; capturing `undefined` once would silently drop all in-app E2EE events while the file log kept working):

```ts
    const e2eeLogger = createE2EEDiagnosticLogger({
      addEvent: (message, category) => this.stores?.console.addEvent(message, category),
    })

    this.e2ee = new E2EEManager({
      storage: this.e2eeStorageBackend,
      xmpp: this.buildE2EEPrimitives(),
      account: { jid: bareJid },
      logger: e2eeLogger,
    })

    this.e2ee.onSecurityContextUpdated(({ peer, messageId, securityContext, body }) => {
      e2eeLogger.info(`trust updated for ${getDomain(peer)} msg ${messageId}: ${securityContext.trust}`)
      this.emitSDK('message:security-updated', {
        conversationId: peer,
        messageId,
        securityContext,
        ...(body !== undefined && { body }),
      })
    })
```

(The rest of `ensureE2EEManager` — `onPluginRegistered`, `onPeerKeysChanged` — is unchanged.)

- [ ] **Step 3: Build the SDK and typecheck**

Run: `npm run build:sdk`
Expected: SUCCESS (no build errors).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the SDK test suite (no regressions)**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: PASS, no stderr. (XMPPClient is integration-tested here; the new injection must not break existing tests. `message:security-updated` behavior is unchanged.)

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/XMPPClient.ts
git commit --no-gpg-sign -m "feat(e2ee): inject fan-out diagnostic logger; log trust updates"
```

---

## Task 9: App typecheck/test pass + full verification

**Files:**
- Possibly modify: `apps/fluux/src/test-setup.ts` (only if a new export is referenced by the app and the mock is missing it)

- [ ] **Step 1: Rebuild the SDK (consumed by the app)**

Run: `npm run build:sdk`
Expected: SUCCESS.

- [ ] **Step 2: App + workspace typecheck**

Run: `npm run typecheck`
Expected: PASS. If it fails because `apps/fluux/src/test-setup.ts`'s `vi.mock('@fluux/sdk', ...)` is missing a newly-referenced export, add it by spreading `importOriginal()` (per repo convention in MEMORY) — but note this change only added internal SDK behavior, so no new public export is expected to be consumed by the app. Do not add a mock entry unless a concrete typecheck/test error names it.

- [ ] **Step 3: Full test suite, clean (no errors / no stderr)**

Run: `npm test`
Expected: PASS for all packages, with no `console.error`/`console.warn` leaking to stderr. (The factory test silences console; the spy-logger tests never touch console; the decrypt-failure path now uses the injected logger, which is `silentLogger` in tests that don't pass one.)

- [ ] **Step 4: Lint**

Run: `npm run lint` (or the repo's configured lint command)
Expected: PASS — in particular, no unused-import errors in `stanzaDecrypt.ts` (verify the `../logger` import was trimmed to only what remains used).

- [ ] **Step 5: Commit any verification-driven fixes**

```bash
git add -A
git commit --no-gpg-sign -m "test(e2ee): verification fixes for E2EE event logging"
```

(Skip if Steps 1-4 required no changes.)

---

## Manual smoke check (optional, recommended before merge)

Demo mode does not exercise real E2EE, so the most reliable manual check is against a server with an OpenPGP-capable peer:

1. `npm run tauri:dev` (or `npm run dev`), log in, open the XMPP console (the events log panel).
2. Trigger an E2EE path that fails (e.g. message a peer who has not published keys → "no mutual E2EE support"; or a locked key → decrypt/encrypt failure).
3. Confirm `[E2EE] …` lines appear in the console, contain **domain-only** peer identifiers (no local part), and contain no plaintext/passphrase/key material.
4. Use the console's export button; confirm the `[E2EE]` lines are in the exported text file.

---

## Self-Review (completed during planning)

- **Spec coverage:**
  - §1 (category + UI): Task 1 (category) + the `[E2EE]` prefix from Task 2's factory. *Deviation from spec:* no new filter chip — the console filter is content-type based, so a chip would require reworking the filter model (YAGNI); the `[E2EE]` prefix + existing search/export deliver isolation. Spec §1 updated to match.
  - §2 (fan-out logger): Task 2 (factory) + Task 8 (injection).
  - §3 (decrypt path onto same logger): Task 3 (accessor) + Task 7 (migration).
  - §4 (events table): plugin reg/unreg + pinned-fallback already exist and light up via Task 8 injection; no-mutual-support Task 4; probe-failed redact + result Task 5; peer-key-change Task 5; trust-updated Task 8; decrypt-failed + dropped-child Task 7; encrypt-failed Task 6.
  - §5 (privacy): `getDomain` redaction in Tasks 4-8; redaction assertions in Tasks 4, 5, 6, 7. *Deviation:* the `fpShort` fingerprint helper from the spec is NOT added — no in-scope event carries a fingerprint, so it would be unused (YAGNI). The "never log full fingerprint" rule stands as call-site discipline; add `fpShort` only when a fingerprint-bearing event is introduced.
  - §6 (testing): per-task Vitest tests + Task 9 full-suite/redaction verification.
- **Placeholder scan:** none — every code step shows the actual code.
- **Type consistency:** `createE2EEDiagnosticLogger(sink?)` / `E2EEDiagnosticSink.addEvent(message, category?)` / `getDiagnosticLogger(): Logger` / `targetLabel(target)` used consistently across Tasks 2-8. `eventCategory` union identical in `console.ts` and `consoleStore.ts` (Task 1).
- **Capability-probe result debug log (§4 row 5):** intentionally folded into the redaction work in Task 5's scope but only the *failure* path is asserted; the success-path debug line is optional polish and may be added inline in Task 5 Step 3 as `this.logger.debug(\`probe ${plugin.descriptor.id} ${getDomain(peer)}: supported\`)` after a positive `support.supported`. Left optional to avoid debug-log noise; not required for the goal.
