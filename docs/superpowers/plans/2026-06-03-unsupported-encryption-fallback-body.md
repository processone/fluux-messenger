# Unsupported-encryption fallback body — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render OMEMO (and any unsupported-protocol) messages using the sender's fallback `<body>` plus a muted "unsupported method" hint, instead of a misleading OpenPGP decrypt-failure placeholder.

**Architecture:** Gate EME-based deferred stashing on `E2EEManager.hasPlugins()`. When the E2EE subsystem is ready and no plugin claims an EME-tagged stanza, the protocol is unsupported → tag the message with `unsupportedEncryption` and keep the fallback body; otherwise stash for retry as today. The deferred-retry pass reclassifies already-stored stuck messages, so existing data self-heals.

**Tech Stack:** TypeScript, Vitest (SDK + app), React + react-i18next, Zustand, `@xmpp/client` / ltx elements.

**Spec:** [docs/superpowers/specs/2026-06-03-unsupported-encryption-fallback-body-design.md](../specs/2026-06-03-unsupported-encryption-fallback-body-design.md)

---

## File Structure

SDK (`packages/fluux-sdk/src/core/`):
- `types/message-base.ts` — add `UnsupportedEncryptionInfo` type + `unsupportedEncryption?` field on the base message.
- `e2ee/stanzaDecrypt.ts` — EME→name map, `recordUnclaimedEME` classifier (replaces `stashEncryptedPayloadViaEME`), `readStashedUnsupportedEncryption`, new `DecryptInPlaceResult.unsupportedEncryption`. **Single source of truth for the classification.**
- `e2ee/stanzaDecrypt.test.ts` — unit tests for the classifier + the no-claim branch.
- `modules/Chat.ts` — live path calls `recordUnclaimedEME`; `processChatMessage` reads the stash. Removes the now-redundant `stashEncryptedPayloadForDeferredDecrypt`.
- `modules/MAM.ts` — archived chat + room construction read the stash.
- `XMPPClient.ts` — `retryDecryptSingle` returns a `RetryOutcome`; the three retry callers handle `unsupported` (self-heal/migration).

App (`apps/fluux/src/`):
- `components/conversation/MessageBubble.tsx` — muted lock hint in the header indicator slot + memo comparator.
- `components/conversation/MessageBubble.test.tsx` — rendering test.
- `i18n/locales/*.json` — one new key in all 33 locales.

---

## Task 1: SDK message type — `unsupportedEncryption` field

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/message-base.ts:201-216`

- [ ] **Step 1: Add the type + field**

In `message-base.ts`, the base message interface currently ends with `encryptedPayload?` at line 201 followed by the closing `}` at 202, then the `MessageSecurityContext` interface. Replace lines 201-202:

```ts
  encryptedPayload?: string
}
```

with:

```ts
  encryptedPayload?: string
  /**
   * Set when an incoming message used an end-to-end encryption protocol this
   * client has no plugin for (e.g. OMEMO when only OpenPGP is wired). Unlike
   * {@link encryptedPayload} there is nothing to retry — we will never decrypt
   * it — so the SDK surfaces the sender's XEP-0380 fallback `<body>` verbatim
   * and tags the message with the protocol it couldn't handle, letting the UI
   * show a muted "unsupported method" hint. Mutually exclusive with
   * `encryptedPayload` in practice.
   */
  unsupportedEncryption?: UnsupportedEncryptionInfo
}

/**
 * Identity of an E2EE protocol this client cannot decrypt. `name` is a
 * human-readable label (e.g. "OMEMO"); `namespace` is the XEP-0380 EME
 * namespace (e.g. `eu.siacs.conversations.axolotl`).
 */
export interface UnsupportedEncryptionInfo {
  namespace: string
  name: string
}
```

- [ ] **Step 2: Typecheck the SDK package**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: PASS (no errors). The field is additive and optional.

- [ ] **Step 3: Commit**

```bash
git add packages/fluux-sdk/src/core/types/message-base.ts
git commit -m "feat(sdk): add unsupportedEncryption message field"
```

---

## Task 2: SDK — `recordUnclaimedEME` classifier

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts` (add new functions near the existing stash helpers)
- Test: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts`

This task adds the classifier and its readers/types **alongside** the existing `stashEncryptedPayloadViaEME` (which Task 3 removes), so the package keeps compiling and tests stay green.

- [ ] **Step 1: Write failing unit tests**

Append to `stanzaDecrypt.test.ts` (after the existing `describe` blocks). Also add the two new imports to the existing import block from `'./stanzaDecrypt'` (lines 11-18): add `recordUnclaimedEME` and `readStashedUnsupportedEncryption`.

```ts
// ---------------------------------------------------------------------------
// Unsupported vs not-ready classification (recordUnclaimedEME)
// ---------------------------------------------------------------------------

describe('recordUnclaimedEME', () => {
  function omemoStanza(): Element {
    return xml(
      'message',
      { from: 'peer@example.com/r', id: 'o1', type: 'chat' },
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' }),
      xml('body', {}, 'I sent you an OMEMO encrypted message.'),
    ) as Element
  }

  it('classifies an EME-tagged stanza as unsupported when plugins are ready', () => {
    const stanza = omemoStanza()
    const disposition = recordUnclaimedEME(stanza, true)

    expect(disposition.kind).toBe('unsupported')
    if (disposition.kind === 'unsupported') {
      expect(disposition.info).toEqual({ namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' })
    }
    expect(readStashedUnsupportedEncryption(stanza)).toEqual({
      namespace: 'eu.siacs.conversations.axolotl',
      name: 'OMEMO',
    })
    // Fallback body is left untouched
    expect(stanza.getChildText('body')).toBe('I sent you an OMEMO encrypted message.')
  })

  it('classifies as retry (stash for deferred decrypt) when no plugins are ready', () => {
    const stanza = omemoStanza()
    const disposition = recordUnclaimedEME(stanza, false)

    expect(disposition.kind).toBe('retry')
    if (disposition.kind === 'retry') {
      expect(disposition.encryptedPayloadXml).toContain('eu.siacs.conversations.axolotl')
    }
    expect(readStashedUnsupportedEncryption(stanza)).toBeUndefined()
  })

  it('detects the protocol from the child namespace when there is no EME hint (retry-shaped stanza)', () => {
    // retryDecryptSingle rebuilds a stanza from the stashed <encrypted> element
    // only — no EME hint. The child namespace alone must still classify it.
    const stanza = xml(
      'message',
      { from: 'peer@example.com/r', id: 'o2', type: 'chat' },
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
    ) as Element

    const disposition = recordUnclaimedEME(stanza, true)
    expect(disposition.kind).toBe('unsupported')
    if (disposition.kind === 'unsupported') {
      expect(disposition.info.name).toBe('OMEMO')
    }
  })

  it('returns none for a cleartext stanza', () => {
    const stanza = xml('message', { from: 'peer@example.com/r', type: 'chat' }, xml('body', {}, 'hi')) as Element
    expect(recordUnclaimedEME(stanza, true).kind).toBe('none')
    expect(recordUnclaimedEME(stanza, false).kind).toBe('none')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts`
Expected: FAIL — `recordUnclaimedEME` / `readStashedUnsupportedEncryption` are not exported.

- [ ] **Step 3: Implement the classifier**

In `stanzaDecrypt.ts`, find the existing `stashEncryptedPayloadViaEME` function (around lines 367-390) and insert the following block **immediately before it** (do NOT delete `stashEncryptedPayloadViaEME` yet — Task 3 removes it). All imports needed (`xml`, `Element`, `NS_EME`, `logInfo`, `stashPayload`) already exist in this file.

```ts
// ---------------------------------------------------------------------------
// Unsupported / not-yet-ready encryption classification
// ---------------------------------------------------------------------------

/**
 * Display names for known XEP-0380 EME namespaces, used to label messages
 * encrypted with a protocol this build has no plugin for. Falls back to the
 * EME `name` attribute, then the raw namespace, when not listed here.
 */
const EME_PROTOCOL_NAMES: Record<string, string> = {
  'eu.siacs.conversations.axolotl': 'OMEMO',
  'urn:xmpp:omemo:2': 'OMEMO 2',
  'urn:xmpp:openpgp:0': 'OpenPGP',
  'jabber:x:encrypted': 'Legacy OpenPGP',
  'urn:xmpp:otr:0': 'OTR',
}

const KNOWN_ENCRYPTION_NAMESPACES = new Set(Object.keys(EME_PROTOCOL_NAMES))

/**
 * Identity of an encryption protocol surfaced to the UI. Structurally mirrors
 * `UnsupportedEncryptionInfo` in the message types; kept separate to avoid an
 * e2ee→types import cycle (same pattern as SecurityContext/MessageSecurityContext).
 */
interface EMEIdentity {
  namespace: string
  name: string
}

/**
 * Outcome of classifying a `<message>` whose encrypted child no plugin claimed.
 * - `retry`: E2EE isn't ready yet — the payload is stashed for deferred retry.
 * - `unsupported`: a plugin is registered but none handles this protocol — the
 *   sender's fallback `<body>` should be shown; the message is tagged so the UI
 *   can render an "unsupported method" hint.
 * - `none`: the stanza isn't actually encryption-tagged (cleartext / malformed).
 */
export type UnclaimedEMEDisposition =
  | { kind: 'retry'; encryptedPayloadXml: string }
  | { kind: 'unsupported'; info: EMEIdentity }
  | { kind: 'none' }

const UNSUPPORTED_ENC_STASH = '__unsupportedEncryption'

/**
 * Locate the encryption namespace + encrypted child of an unclaimed stanza.
 * Prefers the XEP-0380 EME hint; falls back to any child whose own namespace
 * is a known encryption namespace (covers retry stanzas rebuilt from a stashed
 * `<encrypted>` element, which carry no EME hint).
 */
function findEncryptionTarget(
  stanza: Element,
): { namespace: string; child: Element | null; emeName?: string } | null {
  const emeEl = stanza.getChild('encryption', NS_EME)
  const emeNs = emeEl?.attrs.namespace as string | undefined
  const emeName = emeEl?.attrs.name as string | undefined
  for (const child of stanza.children) {
    if (typeof child === 'string') continue
    const childEl = child as Element
    const xmlns = childEl.attrs?.xmlns as string | undefined
    if (!xmlns) continue
    if (emeNs ? xmlns === emeNs : KNOWN_ENCRYPTION_NAMESPACES.has(xmlns)) {
      return { namespace: xmlns, child: childEl, ...(emeName && { emeName }) }
    }
  }
  if (emeNs) return { namespace: emeNs, child: null, ...(emeName && { emeName }) }
  return null
}

/**
 * Classify and tag an encryption-tagged stanza that no plugin claimed, mutating
 * the stanza with the appropriate stash. See {@link UnclaimedEMEDisposition}.
 *
 * @param hasPlugins - whether the E2EE manager has at least one plugin
 *   registered. When false the protocol may still be one we support whose
 *   plugin hasn't finished init — stash for retry. When true an unclaimed
 *   stanza is a protocol we have no plugin for — unsupported.
 */
export function recordUnclaimedEME(
  stanza: Element,
  hasPlugins: boolean,
): UnclaimedEMEDisposition {
  const target = findEncryptionTarget(stanza)
  if (!target) return { kind: 'none' }

  if (hasPlugins) {
    const name = EME_PROTOCOL_NAMES[target.namespace] ?? target.emeName ?? target.namespace
    const info: EMEIdentity = { namespace: target.namespace, name }
    ;(stanza as unknown as Record<string, EMEIdentity>)[UNSUPPORTED_ENC_STASH] = info
    logInfo(`E2EE: message uses unsupported encryption (${name} / ${target.namespace})`)
    return { kind: 'unsupported', info }
  }

  // Not ready yet — stash the encrypted child for retryPendingDecrypts().
  const payloadXml = target.child?.toString()
  if (!payloadXml) return { kind: 'none' }
  stashPayload(stanza, payloadXml)
  logInfo(`E2EE: stashed encrypted payload (ns=${target.namespace}) for deferred decrypt`)
  return { kind: 'retry', encryptedPayloadXml: payloadXml }
}

/** Read back the unsupported-encryption identity recorded by {@link recordUnclaimedEME}. */
export function readStashedUnsupportedEncryption(stanza: Element): EMEIdentity | undefined {
  return (stanza as unknown as { [UNSUPPORTED_ENC_STASH]?: EMEIdentity })[
    UNSUPPORTED_ENC_STASH
  ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts`
Expected: PASS (all `recordUnclaimedEME` tests green; pre-existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts
git commit -m "feat(sdk): add recordUnclaimedEME to classify unsupported vs not-ready encryption"
```

---

## Task 3: SDK — wire `decryptStanzaInPlace` to the classifier

**Files:**
- Modify: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts` (`DecryptInPlaceResult`, no-claim branch; remove `stashEncryptedPayloadViaEME`)
- Test: `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts`

- [ ] **Step 1: Write failing integration test**

Append to `stanzaDecrypt.test.ts`:

```ts
// ---------------------------------------------------------------------------
// decryptStanzaInPlace: unsupported protocol with a registered plugin
// ---------------------------------------------------------------------------

describe('decryptStanzaInPlace unsupported encryption', () => {
  function omemoStanza(): Element {
    return xml(
      'message',
      { from: 'peer@example.com/r', id: 'u1', type: 'chat' },
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' }),
      xml('body', {}, 'OMEMO fallback'),
    ) as Element
  }

  it('flags OMEMO as unsupported (no payload stash) when a non-claiming plugin is registered', async () => {
    // FakeE2EEPlugin only claims urn:test:e2ee:0, so it never claims OMEMO,
    // but its presence means hasPlugins() === true.
    const manager = await makeManager(new FakeE2EEPlugin(undefined))
    const stanza = omemoStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(false)
    expect(result.encryptedPayloadXml).toBeUndefined()
    expect(result.unsupportedEncryption).toEqual({
      namespace: 'eu.siacs.conversations.axolotl',
      name: 'OMEMO',
    })
    expect(readStashedUnsupportedEncryption(stanza)).toEqual({
      namespace: 'eu.siacs.conversations.axolotl',
      name: 'OMEMO',
    })
    expect(stanza.getChildText('body')).toBe('OMEMO fallback')
  })

  it('stashes OMEMO for retry when no plugin is registered', async () => {
    const manager = makeEmptyManager()
    const stanza = omemoStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(false)
    expect(result.unsupportedEncryption).toBeUndefined()
    expect(result.encryptedPayloadXml).toContain('eu.siacs.conversations.axolotl')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts -t "unsupported encryption"`
Expected: FAIL — `result.unsupportedEncryption` is undefined (no-claim branch still stashes via the old path).

- [ ] **Step 3: Add the result field**

In `stanzaDecrypt.ts`, in the `DecryptInPlaceResult` interface (around lines 70-88), add after the `encryptedPayloadXml?` field (before the closing `}`):

```ts
  /**
   * Set when the stanza is encrypted with a protocol this client has no plugin
   * for (e.g. OMEMO when only OpenPGP is wired). Mutually exclusive with
   * `encryptedPayloadXml`. Callers tag the message and surface its fallback
   * `<body>` instead of a decrypt-failure placeholder.
   */
  unsupportedEncryption?: { namespace: string; name: string }
```

- [ ] **Step 4: Rewire the no-claim branch**

Replace the no-claim branch (current lines ~148-156):

```ts
  if (!claim || !encryptedChild) {
    // No plugin claimed — check if this is still an encrypted message via
    // XEP-0380 EME (Explicit Message Encryption). This happens when no
    // plugin is registered yet (race at startup) or the message uses a
    // protocol this client doesn't support. Stash the encrypted element
    // so retryPendingDecrypts() can re-attempt when a plugin is available.
    const payloadXml = stashEncryptedPayloadViaEME(stanza)
    return { attempted: false, ...(payloadXml && { encryptedPayloadXml: payloadXml }) }
  }
```

with:

```ts
  if (!claim || !encryptedChild) {
    // No plugin claimed. recordUnclaimedEME tells apart "E2EE not ready yet"
    // (no plugin registered — stash for deferred retry) from "protocol we have
    // no plugin for" (e.g. OMEMO when only OpenPGP is wired — surface the
    // sender's XEP-0380 fallback <body> with an unsupported-method tag).
    const disposition = recordUnclaimedEME(stanza, manager.hasPlugins())
    if (disposition.kind === 'retry') {
      return { attempted: false, encryptedPayloadXml: disposition.encryptedPayloadXml }
    }
    if (disposition.kind === 'unsupported') {
      return { attempted: false, unsupportedEncryption: disposition.info }
    }
    return { attempted: false }
  }
```

- [ ] **Step 5: Remove the now-unused `stashEncryptedPayloadViaEME`**

Delete the entire `stashEncryptedPayloadViaEME` function (the JSDoc block + function, current lines ~367-390 — the block starting `/**` … `EME-based fallback:` … through its closing `}`). `recordUnclaimedEME` fully replaces it.

- [ ] **Step 6: Run the full stanzaDecrypt test file**

Run: `cd packages/fluux-sdk && npx vitest run src/core/e2ee/stanzaDecrypt.test.ts`
Expected: PASS — including the pre-existing "EME-based stash without plugin" test (still hits the `retry` branch via `makeEmptyManager`).

- [ ] **Step 7: Typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit`
Expected: PASS — no remaining reference to `stashEncryptedPayloadViaEME`.

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.test.ts
git commit -m "feat(sdk): surface unsupported-encryption disposition from decryptStanzaInPlace"
```

---

## Task 4: SDK — Chat live path + message construction

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts:36-44` (imports), `:197-204` (live path), `:424-446` (remove method), `:1914-1933` (processChatMessage)
- Test: `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts`

- [ ] **Step 1: Write a failing test**

Open `Chat.e2ee.test.ts` and find an existing test that drives an inbound encrypted stanza through the Chat handler with a registered manager (search for `decryptStanzaInPlace` usage or an `emitSDK('chat:message'` assertion to mirror the harness). Add a test in the same style:

```ts
it('surfaces the fallback body and tags unsupportedEncryption for an OMEMO message', async () => {
  // Build a Chat module with an E2EE manager that has a plugin registered but
  // does NOT claim OMEMO (mirror the harness used by the surrounding tests).
  // Drive an inbound OMEMO stanza:
  const stanza = xml(
    'message',
    { from: 'peer@example.com/r', to: 'me@example.com/x', id: 'omemo-1', type: 'chat' },
    xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
    xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' }),
    xml('body', {}, 'I sent you an OMEMO encrypted message.'),
  )

  // Emit through the same entry point the other Chat.e2ee tests use, then read
  // the emitted Message (via the captured emitSDK('chat:message') payload).
  const message = /* captured emitted message */ undefined as any

  expect(message.body).toBe('I sent you an OMEMO encrypted message.')
  expect(message.encryptedPayload).toBeUndefined()
  expect(message.unsupportedEncryption).toEqual({
    namespace: 'eu.siacs.conversations.axolotl',
    name: 'OMEMO',
  })
})
```

> Note for the implementer: match the existing test harness in `Chat.e2ee.test.ts` for constructing the Chat module + capturing emitted messages (the file already mocks `emitSDK` / stores). Use the surrounding tests' helper to register a non-claiming plugin and to feed `stanza` into the handler. The three assertions above are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "unsupportedEncryption"`
Expected: FAIL — `message.unsupportedEncryption` is undefined and `encryptedPayload` is set (old behaviour).

- [ ] **Step 3: Update Chat imports**

In `Chat.ts`, the import block from `'../e2ee/stanzaDecrypt'` (lines 36-44) currently lists `decryptStanzaInPlace, deriveConversationContext, readStashedAuthoredAt, readStashedEncryptedPayload, readStashedSecurityContext, stanzaHasE2EEClaim, stanzaHasEMEHint`. Add `recordUnclaimedEME` and `readStashedUnsupportedEncryption`:

```ts
import {
  decryptStanzaInPlace,
  deriveConversationContext,
  readStashedAuthoredAt,
  readStashedEncryptedPayload,
  readStashedSecurityContext,
  readStashedUnsupportedEncryption,
  recordUnclaimedEME,
  stanzaHasE2EEClaim,
  stanzaHasEMEHint,
} from '../e2ee/stanzaDecrypt'
```

- [ ] **Step 4: Rewire the live path**

Replace the live-path block (current lines ~197-204):

```ts
    // Deferred decrypt: when tryHandleEncrypted returned false (no plugin
    // registered or no manager), detect encrypted messages via EME hint and
    // stash the encrypted payload for later retry. decryptStanzaInPlace
    // handles the case where a manager exists but no plugin claims; this
    // covers the case where no manager exists at all.
    if (!readStashedEncryptedPayload(stanza) && stanzaHasEMEHint(stanza)) {
      this.stashEncryptedPayloadForDeferredDecrypt(stanza)
    }
```

with:

```ts
    // tryHandleEncrypted returned false: no plugin claimed the stanza (or there
    // is no manager). recordUnclaimedEME tags it — when a plugin is registered,
    // an unclaimed EME stanza is an unsupported protocol (e.g. OMEMO) so the
    // fallback <body> is shown with an "unsupported method" hint; otherwise the
    // payload is stashed for retryPendingDecrypts() once a plugin comes online.
    const e2eeManager = this.deps.getE2EEManager?.()
    if (
      !readStashedEncryptedPayload(stanza) &&
      !readStashedUnsupportedEncryption(stanza) &&
      stanzaHasEMEHint(stanza)
    ) {
      recordUnclaimedEME(stanza, !!e2eeManager?.hasPlugins())
    }
```

- [ ] **Step 5: Remove the redundant `stashEncryptedPayloadForDeferredDecrypt` method**

Delete the entire private method `stashEncryptedPayloadForDeferredDecrypt` (its JSDoc block + body, current lines ~424-446). `recordUnclaimedEME` replaces it.

- [ ] **Step 6: Read the stash in `processChatMessage`**

In `processChatMessage` (around lines 1914-1933), after the line `const encryptedPayload = readStashedEncryptedPayload(stanza)`, add:

```ts
    const unsupportedEncryption = readStashedUnsupportedEncryption(stanza)
```

Then in the `const message: Message = { … }` literal, after the line `...(encryptedPayload && { encryptedPayload }),`, add:

```ts
      ...(unsupportedEncryption && { unsupportedEncryption }),
```

- [ ] **Step 7: Run the test + full Chat suite**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts src/core/modules/Chat.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts
git commit -m "feat(sdk): surface fallback body + unsupportedEncryption tag on live OMEMO messages"
```

---

## Task 5: SDK — MAM archived chat + room

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts:75-81` (imports), `:1746-1765` (chat), `:1814-1835` (room)

No new behaviour to test beyond Task 3 (MAM routes archived stanzas through the same `decryptStanzaInPlace`); this task only plumbs the stash onto archived messages, mirroring `encryptedPayload`.

- [ ] **Step 1: Update MAM imports**

In `MAM.ts`, the import from `'../e2ee/stanzaDecrypt'` (lines 75-81) lists `decryptStanzaInPlace, deriveConversationContext, readStashedAuthoredAt, readStashedEncryptedPayload, readStashedSecurityContext`. Add `readStashedUnsupportedEncryption`:

```ts
import {
  decryptStanzaInPlace,
  deriveConversationContext,
  readStashedAuthoredAt,
  readStashedEncryptedPayload,
  readStashedSecurityContext,
  readStashedUnsupportedEncryption,
} from '../e2ee/stanzaDecrypt'
```

- [ ] **Step 2: Archived chat message**

Around line 1747, after `const encryptedPayload = readStashedEncryptedPayload(messageEl)`, add:

```ts
    const unsupportedEncryption = readStashedUnsupportedEncryption(messageEl)
```

In the returned object literal, after `...(encryptedPayload && { encryptedPayload }),` (line ~1764), add:

```ts
      ...(unsupportedEncryption && { unsupportedEncryption }),
```

- [ ] **Step 3: Archived room message**

Around line 1815, after `const roomEncryptedPayload = readStashedEncryptedPayload(messageEl)`, add:

```ts
    const roomUnsupportedEncryption = readStashedUnsupportedEncryption(messageEl)
```

In the `const message: RoomMessage = { … }` literal, after `...(roomEncryptedPayload && { encryptedPayload: roomEncryptedPayload }),` (line ~1834), add:

```ts
      ...(roomUnsupportedEncryption && { unsupportedEncryption: roomUnsupportedEncryption }),
```

- [ ] **Step 4: Typecheck + MAM tests**

Run: `cd packages/fluux-sdk && npx tsc --noEmit && npx vitest run src/core/modules/MAM.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/MAM.ts
git commit -m "feat(sdk): tag archived OMEMO messages with unsupportedEncryption"
```

---

## Task 6: SDK — retry self-heal (migration for stuck messages)

**Files:**
- Modify: `packages/fluux-sdk/src/core/XMPPClient.ts:1602-1665` (retryPendingDecrypts), `:1672-1739` (retryDecryptSingle), `:1758-1801` (retryPendingDecryptsForPeer)
- Test: `packages/fluux-sdk/src/core/XMPPClient.test.ts` (or the existing retry-focused test file)

- [ ] **Step 1: Write a failing test**

Find the existing test that exercises `retryPendingDecrypts` (search `retryPendingDecrypts` in `packages/fluux-sdk/src/core/`). Mirror its harness to add:

```ts
it('reclassifies a stored OMEMO message as unsupported and clears encryptedPayload', async () => {
  // Seed a stored chat message whose encryptedPayload is a serialized OMEMO
  // <encrypted> element, and a manager with a registered (non-claiming) plugin.
  const omemoXml = '<encrypted xmlns="eu.siacs.conversations.axolotl">cipher</encrypted>'
  // ...seed chatStore with a message { id, from, body: 'OMEMO fallback', encryptedPayload: omemoXml }
  // ...register a non-claiming plugin so manager.hasPlugins() === true

  await client.retryPendingDecrypts()

  // ...read the updated message back from the store
  const updated = /* stored message */ undefined as any
  expect(updated.encryptedPayload).toBeUndefined()
  expect(updated.unsupportedEncryption).toEqual({
    namespace: 'eu.siacs.conversations.axolotl',
    name: 'OMEMO',
  })
  expect(updated.body).toBe('OMEMO fallback') // body untouched
})
```

> Note for the implementer: reuse the surrounding test's store-seeding + manager-construction helpers. The four assertions are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/core/XMPPClient.test.ts -t "unsupported"`
Expected: FAIL — `retryDecryptSingle` returns `null` for OMEMO, so the message stays with `encryptedPayload` set.

- [ ] **Step 3: Add the `RetryOutcome` type**

In `XMPPClient.ts`, immediately above the `retryDecryptSingle` method (around line 1672, after its JSDoc), add:

```ts
/**
 * Result of a single deferred-decrypt attempt.
 * - `decrypted`: plaintext recovered — update body/security/attachment, clear `encryptedPayload`.
 * - `unsupported`: protocol we have no plugin for — clear `encryptedPayload`, tag `unsupportedEncryption`, keep body.
 * - `pending`: still cannot decrypt (key locked / plugin not ready) — leave `encryptedPayload`.
 */
type RetryOutcome =
  | { kind: 'decrypted'; body: string; securityContext?: MessageSecurityContext; attachment?: FileAttachment }
  | { kind: 'unsupported'; info: { namespace: string; name: string } }
  | { kind: 'pending' }
```

> Place this `type` at module scope (top-level), not inside the class. If the file groups module-level types elsewhere, follow that placement; otherwise just above the class method's region is fine as a top-level declaration.

- [ ] **Step 4: Rewrite `retryDecryptSingle`**

Replace the whole method body (current lines 1672-1739). New version returns `RetryOutcome`:

```ts
  private async retryDecryptSingle(
    manager: E2EEManager,
    encryptedPayloadXml: string,
    senderJid: string,
    peer: string,
  ): Promise<RetryOutcome> {
    try {
      // Parse the serialized encrypted element back into an Element
      const ltx = await import('ltx')
      const encryptedEl = ltx.parse(encryptedPayloadXml) as unknown as Element

      const ownBareJid = this.currentJid ? getBareJid(this.currentJid) : ''
      const isSelfOutgoing = ownBareJid !== '' && getBareJid(senderJid) === ownBareJid
      const stanza = xml('message', { from: senderJid }, encryptedEl)

      const result = await decryptStanzaInPlace(
        stanza, manager, peer, 'archive',
        isSelfOutgoing ? { isSelfOutgoing: true } : undefined,
      )

      // Protocol we have no plugin for (e.g. OMEMO): nothing to retry. Drop the
      // encryptedPayload and tag the message so the already-stored fallback body
      // renders with an "unsupported method" hint.
      if (result.unsupportedEncryption) {
        return { kind: 'unsupported', info: result.unsupportedEncryption }
      }

      if (!result.attempted || result.encryptedPayloadXml) {
        return { kind: 'pending' }
      }

      const body = stanza.getChildText('body')
      if (!body) return { kind: 'pending' }

      const attachment = parseOobData(stanza)
      if (attachment) {
        logDebug(
          `E2EE deferred decrypt: attachment from ${senderJid} — ` +
          `url=${attachment.url.slice(0, 40)}… mediaType=${attachment.mediaType ?? 'none'} ` +
          `encrypted=${!!attachment.encryption} name=${attachment.name ?? 'none'}`,
        )
      }

      let securityContext: MessageSecurityContext | undefined
      if (result.securityContext) {
        securityContext = {
          protocolId: result.securityContext.protocolId,
          trust: result.securityContext.trust,
          ...(result.securityContext.notes && { notes: result.securityContext.notes }),
        }
      }

      if (securityContext?.trust === 'rejected') {
        return { kind: 'decrypted', body: '[Message rejected: invalid signature]', securityContext }
      }

      return {
        kind: 'decrypted',
        body,
        ...(securityContext && { securityContext }),
        ...(attachment && { attachment }),
      }
    } catch (err) {
      logWarn(`E2EE deferred decrypt failed for message from ${senderJid}: ${err instanceof Error ? err.message : String(err)}`)
      return { kind: 'pending' }
    }
  }
```

- [ ] **Step 5: Update the chat + room loops in `retryPendingDecrypts`**

Replace the chat loop body (current lines ~1620-1633):

```ts
        for (const msg of messages) {
          if (!msg.encryptedPayload) continue
          const result = await this.retryDecryptSingle(
            manager, msg.encryptedPayload, msg.from, conversationId,
          )
          if (result) {
            chatBindings.updateMessage(conversationId, msg.id, {
              body: result.body,
              ...(result.securityContext && { securityContext: result.securityContext }),
              ...(result.attachment && { attachment: result.attachment }),
              encryptedPayload: undefined,
            })
            decryptedCount++
          }
        }
```

with:

```ts
        for (const msg of messages) {
          if (!msg.encryptedPayload) continue
          const outcome = await this.retryDecryptSingle(
            manager, msg.encryptedPayload, msg.from, conversationId,
          )
          if (outcome.kind === 'decrypted') {
            chatBindings.updateMessage(conversationId, msg.id, {
              body: outcome.body,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              ...(outcome.attachment && { attachment: outcome.attachment }),
              encryptedPayload: undefined,
            })
            decryptedCount++
          } else if (outcome.kind === 'unsupported') {
            chatBindings.updateMessage(conversationId, msg.id, {
              encryptedPayload: undefined,
              unsupportedEncryption: outcome.info,
            })
          }
        }
```

Replace the room loop body (current lines ~1640-1653) identically, but with `roomBindings` and `roomJid`:

```ts
        for (const msg of runtime.messages) {
          if (!msg.encryptedPayload) continue
          const outcome = await this.retryDecryptSingle(
            manager, msg.encryptedPayload, msg.from, roomJid,
          )
          if (outcome.kind === 'decrypted') {
            roomBindings.updateMessage(roomJid, msg.id, {
              body: outcome.body,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              ...(outcome.attachment && { attachment: outcome.attachment }),
              encryptedPayload: undefined,
            })
            decryptedCount++
          } else if (outcome.kind === 'unsupported') {
            roomBindings.updateMessage(roomJid, msg.id, {
              encryptedPayload: undefined,
              unsupportedEncryption: outcome.info,
            })
          }
        }
```

- [ ] **Step 6: Update the peer loop in `retryPendingDecryptsForPeer`**

Replace the `if (msg.encryptedPayload) { … }` block (current lines ~1770-1784):

```ts
      if (msg.encryptedPayload) {
        const result = await this.retryDecryptSingle(
          manager, msg.encryptedPayload, msg.from, peer,
        )
        if (result) {
          chatBindings.updateMessage(peer, msg.id, {
            body: result.body,
            ...(result.securityContext && { securityContext: result.securityContext }),
            ...(result.attachment && { attachment: result.attachment }),
            encryptedPayload: undefined,
          })
          updated++
        }
        continue
      }
```

with:

```ts
      if (msg.encryptedPayload) {
        const outcome = await this.retryDecryptSingle(
          manager, msg.encryptedPayload, msg.from, peer,
        )
        if (outcome.kind === 'decrypted') {
          chatBindings.updateMessage(peer, msg.id, {
            body: outcome.body,
            ...(outcome.securityContext && { securityContext: outcome.securityContext }),
            ...(outcome.attachment && { attachment: outcome.attachment }),
            encryptedPayload: undefined,
          })
          updated++
        } else if (outcome.kind === 'unsupported') {
          chatBindings.updateMessage(peer, msg.id, {
            encryptedPayload: undefined,
            unsupportedEncryption: outcome.info,
          })
          updated++
        }
        continue
      }
```

- [ ] **Step 7: Run the test + typecheck**

Run: `cd packages/fluux-sdk && npx tsc --noEmit && npx vitest run src/core/XMPPClient.test.ts`
Expected: PASS — new self-heal test green, existing retry tests green.

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/core/XMPPClient.ts packages/fluux-sdk/src/core/XMPPClient.test.ts
git commit -m "feat(sdk): self-heal stored messages to unsupportedEncryption on retry"
```

---

## Task 7: Build the SDK so the app sees the new type

**Files:** none (build step)

- [ ] **Step 1: Build SDK**

Run: `npm run build:sdk`
Expected: Build succeeds. `unsupportedEncryption` / `UnsupportedEncryptionInfo` now appear in `packages/fluux-sdk/dist/index.d.ts`.

- [ ] **Step 2: Verify the type is exported**

Run: `grep -n "unsupportedEncryption\|UnsupportedEncryptionInfo" packages/fluux-sdk/dist/index.d.ts | head`
Expected: at least one match for each.

---

## Task 8: App — MessageBubble hint + memo comparator

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx:158-160` (memo), `:430-449` (indicator)
- Test: `apps/fluux/src/components/conversation/MessageBubble.test.tsx`

- [ ] **Step 1: Write a failing test**

Append to `MessageBubble.test.tsx`, inside the top-level `describe('MessageBubble', …)`:

```tsx
  describe('Unsupported encryption', () => {
    it('shows the fallback body and a muted lock hint', () => {
      const props = createDefaultProps({
        message: createTestMessage({
          body: "I sent you an OMEMO encrypted message but your client doesn't support it.",
          unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' },
        }),
      })
      const { container } = render(<MessageBubble {...props} />)

      // Fallback body is shown (not replaced by a decrypt-failure placeholder)
      expect(screen.getByText(/I sent you an OMEMO encrypted message/)).toBeInTheDocument()

      // Muted lock hint present, labelled with the protocol name
      const hint = container.querySelector(
        '[aria-label="Encrypted with OMEMO, unsupported method"]',
      )
      expect(hint).not.toBeNull()

      // Click reveals the tooltip (t() returns the key in tests)
      fireEvent.click(hint!.parentElement!)
      expect(screen.getByRole('tooltip').textContent).toContain(
        'chat.encryption.unsupportedMethodTooltip',
      )
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx -t "Unsupported encryption"`
Expected: FAIL — no element with that aria-label.

- [ ] **Step 3: Add the memo comparison**

In `MessageBubble.tsx`, after the security-context comparison block (lines 158-160, ending `if (prevSec !== nextSec) return false`), add:

```ts
  // Unsupported-encryption tag — drives the muted lock hint. retryPendingDecrypts()
  // can set this on an already-rendered message (migration of stored OMEMO
  // messages), so it must invalidate the memo like securityContext does.
  const prevUnsup = JSON.stringify(prev.message.unsupportedEncryption ?? null)
  const nextUnsup = JSON.stringify(next.message.unsupportedEncryption ?? null)
  if (prevUnsup !== nextUnsup) return false
```

- [ ] **Step 4: Add the indicator branch**

In `MessageBubble.tsx`, immediately after the `{message.securityContext && ( … )}` block (closes at line 449 `)}`), add:

```tsx
            {!message.securityContext && message.unsupportedEncryption && (
              <Tooltip
                content={t('chat.encryption.unsupportedMethodTooltip', {
                  method: message.unsupportedEncryption.name,
                })}
                position="top"
                triggerMode="click"
              >
                <span
                  className="flex items-center text-fluux-muted"
                  aria-label={`Encrypted with ${message.unsupportedEncryption.name}, unsupported method`}
                >
                  <Lock className="size-3" />
                </span>
              </Tooltip>
            )}
```

> `Lock` and `Tooltip` are already imported in this file (used by the securityContext block). No new imports.

- [ ] **Step 5: Run the test + full MessageBubble suite**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageBubble.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/conversation/MessageBubble.test.tsx
git commit -m "feat(app): render fallback body + muted unsupported-encryption hint"
```

---

## Task 9: i18n — `unsupportedMethodTooltip` in all 33 locales

**Files:**
- Modify: every `apps/fluux/src/i18n/locales/*.json`

Each locale has a `chat.encryption` block containing `"couldNotDecryptTooltip"` (verified present in all 33 files). Add the new key on the line **after** `"couldNotDecryptTooltip"` in each file. JSON key order is irrelevant; just keep valid JSON (the preceding line already ends with a comma, so the new line must end with a comma too unless it's the last key — it isn't, since `couldNotDecryptTooltip` is followed by more keys).

- [ ] **Step 1: Add the translated key to each locale**

For each file, insert after its `"couldNotDecryptTooltip": "…",` line:

```
            "unsupportedMethodTooltip": "<TRANSLATION>",
```

Use these translations (keep `{{method}}` literal in every one):

| file | translation |
|------|-------------|
| ar.json | `مُشفّر باستخدام {{method}} — طريقة لا يدعمها هذا الجهاز بعد` |
| be.json | `Зашыфравана з дапамогай {{method}} — гэты метад пакуль не падтрымліваецца на гэтай прыладзе` |
| bg.json | `Шифровано с {{method}} — метод, който това устройство все още не поддържа` |
| ca.json | `Xifrat amb {{method}} — un mètode que aquest dispositiu encara no admet` |
| cs.json | `Šifrováno pomocí {{method}} — metoda, kterou toto zařízení zatím nepodporuje` |
| da.json | `Krypteret med {{method}} — en metode, som denne enhed endnu ikke understøtter` |
| de.json | `Mit {{method}} verschlüsselt – eine Methode, die dieses Gerät noch nicht unterstützt` |
| el.json | `Κρυπτογραφημένο με {{method}} — μέθοδος που δεν υποστηρίζεται ακόμη σε αυτή τη συσκευή` |
| en.json | `Encrypted with {{method}} — a method this device doesn't support yet` |
| es.json | `Cifrado con {{method}}: un método que este dispositivo aún no admite` |
| et.json | `Krüptitud meetodiga {{method}} — seda meetodit see seade veel ei toeta` |
| fi.json | `Salattu menetelmällä {{method}} — tätä menetelmää tämä laite ei vielä tue` |
| fr.json | `Chiffré avec {{method}} — méthode non prise en charge sur cet appareil` |
| ga.json | `Criptithe le {{method}} — modh nach dtacaíonn an gléas seo leis go fóill` |
| he.json | `מוצפן באמצעות {{method}} — שיטה שמכשיר זה עדיין אינו תומך בה` |
| hr.json | `Šifrirano pomoću {{method}} — metoda koju ovaj uređaj još ne podržava` |
| hu.json | `{{method}} titkosítással — ezt a módszert ez az eszköz még nem támogatja` |
| is.json | `Dulkóðað með {{method}} — aðferð sem þetta tæki styður ekki enn` |
| it.json | `Crittografato con {{method}} — un metodo non ancora supportato da questo dispositivo` |
| lt.json | `Užšifruota naudojant {{method}} — šis metodas dar nepalaikomas šiame įrenginyje` |
| lv.json | `Šifrēts ar {{method}} — šī metode šajā ierīcē vēl netiek atbalstīta` |
| mt.json | `Ikkriptat bi {{method}} — metodu li dan l-apparat għadu ma jappoġġjax` |
| nb.json | `Kryptert med {{method}} — en metode denne enheten ennå ikke støtter` |
| nl.json | `Versleuteld met {{method}} — een methode die dit apparaat nog niet ondersteunt` |
| pl.json | `Zaszyfrowano metodą {{method}} — ta metoda nie jest jeszcze obsługiwana na tym urządzeniu` |
| pt.json | `Encriptado com {{method}} — um método que este dispositivo ainda não suporta` |
| ro.json | `Criptat cu {{method}} — o metodă pe care acest dispozitiv nu o acceptă încă` |
| ru.json | `Зашифровано с помощью {{method}} — этот метод пока не поддерживается на этом устройстве` |
| sk.json | `Šifrované pomocou {{method}} — metóda, ktorú toto zariadenie zatiaľ nepodporuje` |
| sl.json | `Šifrirano z {{method}} — metoda, ki je ta naprava še ne podpira` |
| sv.json | `Krypterat med {{method}} — en metod som den här enheten inte stöder ännu` |
| uk.json | `Зашифровано за допомогою {{method}} — цей метод поки не підтримується на цьому пристрої` |
| zh-CN.json | `已使用 {{method}} 加密 — 此设备尚不支持该方式` |

- [ ] **Step 2: Verify the key landed in all 33 and JSON is valid**

Run:
```bash
cd apps/fluux/src/i18n/locales
echo "count:"; grep -l "unsupportedMethodTooltip" *.json | wc -l
for f in *.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "INVALID: $f"; done
```
Expected: `count: 33` and no `INVALID:` lines.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/i18n/locales/*.json
git commit -m "i18n: add unsupportedMethodTooltip in all locales"
```

---

## Task 10: Full verification

**Files:** none

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: All SDK + app tests pass, no stderr noise.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint` (if defined; otherwise the react-doctor pre-commit hook covers staged files)
Expected: no new errors in the changed files.

- [ ] **Step 4: Manual demo check (optional but recommended)**

Per [docs/DEMO_MODE.md](../../DEMO_MODE.md), the demo seeds messages from source. If a demo conversation can include an OMEMO-shaped message, confirm it renders the fallback body + muted lock rather than the decrypt-failure placeholder. (May require clearing `xmpp-chat-storage` in localStorage to re-seed.)

---

## Self-Review

**Spec coverage:**
- Classification (`hasPlugins()` gate, single decision point) → Tasks 2–3 (`recordUnclaimedEME`, no-claim branch).
- New `unsupportedEncryption` field → Task 1; plumbed in Tasks 4 (live), 5 (MAM).
- EME→name map → Task 2 (`EME_PROTOCOL_NAMES`).
- Retry self-heal / migration → Task 6.
- App UI (fallback body + muted hint) + memo → Task 8.
- i18n in all 33 locales → Task 9.
- Edge cases: no-body messages dropped by existing `Chat.ts:363` guard (no task needed — unchanged); startup race self-heals via Task 6; genuine OpenPGP failures untouched (no-claim branch only changes the unclaimed-EME sub-case).

**Type consistency:** `unsupportedEncryption` field is `UnsupportedEncryptionInfo` ({namespace,name}) on the message type (Task 1); `DecryptInPlaceResult.unsupportedEncryption` and `RetryOutcome.info` both use the structurally-identical `{namespace,name}` (Tasks 3, 6) — assignable to the message field by structural typing, matching the existing SecurityContext/MessageSecurityContext precedent. `recordUnclaimedEME` (Task 2) is the only producer; `readStashedUnsupportedEncryption` (Task 2) the only reader; both used consistently in Tasks 3–5. Retry callers (Task 6) switch on `outcome.kind` ∈ {`decrypted`,`unsupported`,`pending`} exactly as defined.

**Placeholder scan:** Two tasks (4, 6) include a test whose harness wiring is described rather than fully written, because they must match each test file's existing mock setup; both state the exact assertion contract. All production-code steps contain complete code.
