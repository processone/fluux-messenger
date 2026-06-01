# E2EE: Encrypt One-to-One Metadata Payloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route reactions, retractions, link previews, and easter eggs through the existing OpenPGP payload envelope in 1:1 encrypted conversations, so these payloads (and the message IDs they reference) no longer leak to the untrusted XMPP server.

**Architecture:** All four are standalone outbound stanzas built in `Chat.ts`. The inbound side is already generic: `decryptStanzaInPlace` re-injects the decrypted envelope children at the stanza root and `decryptAndReprocess` re-enters `handleMessageInternal`, so the existing parsers (`handleIncomingReaction`, `handleFastening`, `handleIncomingRetraction`, the easter-egg branch) run unchanged. The only work is outbound: generalize the private helper `applyE2EEToOutboundChat` so it can wrap body-less, hint-customised payloads, then wire each send method to it — mirroring how `sendCorrection` already encrypts. Each send method keeps its current plaintext behaviour when no E2EE plugin is reachable (permissive mode), and gains the same no-silent-downgrade guarantee in strict mode.

**Tech Stack:** TypeScript, `@fluux/sdk` (`packages/fluux-sdk`), Vitest, `@xmpp/client` (`ltx`) stanza builders, `DummyPlaintextPlugin` for round-trip tests.

**Out of scope:** Chat states (XEP-0085 typing notifications) are deliberately left plaintext — that is a separate product decision (option "b"), not part of this plan. MUC (groupchat) encryption remains a later phase; every send method here only encrypts `type === 'chat'`.

---

## Background — verified facts

These were confirmed by reading the code; an implementer does not need to re-derive them:

- **Inbound is already generic.** `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts:203-213` parses the decrypted `<payload>` envelope and pushes *every* child onto the stanza root, then `Chat.decryptAndReprocess` (`packages/fluux-sdk/src/core/modules/Chat.ts:375-378`) re-enters `handleMessageInternal`. The synthetic second pass has no encrypted child to claim (`stanzaHasE2EEClaim` is false), so it falls through to the parsers. **No inbound code changes are required.**
- **The envelope accepts body-less payloads.** `packages/fluux-sdk/src/core/e2ee/payloadEnvelope.ts:51-90` — `serialize`/`parse` accept any `Element[]`; no `<body>` is required.
- **The plaintext-downgrade guard already lives in the helper.** `applyE2EEToOutboundChat` re-throws when a selected plugin fails mid-encrypt (`packages/fluux-sdk/src/core/modules/Chat.ts:579-593`) and calls `assertPlaintextPermitted` when no plugin matches. Routing the four signals through it gives them the same protection #415 gave message bodies.
- **Namespace literals** (from `packages/fluux-sdk/src/core/namespaces.ts`): `NS_REACTIONS = 'urn:xmpp:reactions:0'`, `NS_RETRACT = 'urn:xmpp:message-retract:1'`, `NS_FASTEN = 'urn:xmpp:fasten:0'`, `NS_EASTER_EGG = 'urn:fluux:easter-egg:0'`, `NS_HINTS = 'urn:xmpp:hints'`, `NS_EME = 'urn:xmpp:eme:0'`, `NS_FALLBACK = 'urn:xmpp:fallback:0'`. All are already imported into `Chat.ts`.
- **Dummy plugin wire shape** (used by round-trip tests): encrypted element `<plain xmlns='urn:fluux:e2ee-dummy:0'>…base64…</plain>`, EME `<encryption xmlns='urn:xmpp:eme:0' namespace='urn:fluux:e2ee-dummy:0'/>`, fallback body `[dummy-plaintext payload]`, outbound trust `verified`.

## File Structure

- **Modify** `packages/fluux-sdk/src/core/modules/Chat.ts`
  - Add the `E2EEOutboundOptions` interface and generalize `applyE2EEToOutboundChat` (Task 1).
  - Add four per-method protected-key sets and wire `sendReaction`, `sendRetraction`, `sendLinkPreview`, `sendEasterEgg` (Tasks 2–5).
  - Update the stale doc comment on `E2EE_PROTECTED_CHILD_KEYS` (Task 6).
- **Modify** `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts`
  - Update one existing reaction test whose assertions hard-code the old plaintext behaviour; add outbound + round-trip + downgrade tests for each signal (Tasks 2–5).
- **Modify** `docs/ENCRYPTION.md`
  - Document the widened protection scope and the explicit chat-states-stay-plaintext decision (Task 6).

## Design reference — the options matrix

`applyE2EEToOutboundChat(recipient, plaintextBody, children, protectedChildKeys?, options?)`. New `options` (all optional, defaults preserve today's behaviour):

| option | default | meaning |
|---|---|---|
| `encryptBody` | `true` | include a `<body>plaintextBody</body>` inside the encrypted envelope |
| `outerBody` | `'fallback'` | after a successful encrypt: `'fallback'` = replace/insert the plugin's `[encrypted message]` body on the outer stanza; `'remove'` = strip any outer `<body>` |
| `storeHint` | `'store'` | hint appended after the encrypted element on success: `'store'`, `'no-store'`, or `'none'` (append nothing — caller manages its own hint) |

Per-method settings:

| method | `protectedChildKeys` | `encryptBody` | `outerBody` | `storeHint` | children the caller still builds |
|---|---|---|---|---|---|
| `sendReaction` | `{reactions\|NS_REACTIONS}` | `false` | `'remove'` | `'store'` | `reactions`, origin-id |
| `sendRetraction` | `{retract\|NS_RETRACT}` | `false` | `'fallback'` | `'store'` | English fallback `body`, `retract`, `fallback`(for retract), origin-id |
| `sendLinkPreview` | `{apply-to\|NS_FASTEN}` | `false` | `'remove'` | `'none'` | `apply-to`, `no-store` |
| `sendEasterEgg` | `{easter-egg\|NS_EASTER_EGG}` | `false` | `'remove'` | `'none'` | `no-store`, `easter-egg` |

Why these choices:
- **Reaction** — built children have no `<body>` when E2EE is reachable (`suppressReplyFallback`), so `'remove'` is a no-op that guarantees no phantom body bubble on legacy clients. The reaction's `id` (the message reacted to) rides inside the envelope.
- **Retraction** — keep building the current English fallback body so the *plaintext* path is unchanged; on a successful encrypt, `outerBody:'fallback'` replaces that retraction-revealing English text with the generic `[encrypted message]` (hiding from the server that this is a retraction), and the helper's existing fallback-removal block strips the now-stale `<fallback for=NS_RETRACT>`.
- **Link preview / easter egg** — these must stay `<no-store>` whether encrypted or not, so the *caller* keeps `<no-store>` in `children` (it rides at the root through encryption) and passes `storeHint:'none'` so the helper does not also add `<store>`.

---

### Task 1: Generalize `applyE2EEToOutboundChat` with `E2EEOutboundOptions`

Behaviour-preserving refactor: existing callers (`sendMessage`, `resendMessage`, `sendCorrection`) pass no options and must behave exactly as before. Validated by the existing `Chat.e2ee.test.ts` suite.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (the `applyE2EEToOutboundChat` method, currently at lines ~461-596, and a new interface near the top of the file)
- Test: `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts` (existing suite, run unchanged as the regression net)

- [ ] **Step 1: Add the `E2EEOutboundOptions` interface**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, immediately before the `export class Chat` declaration (search for `class Chat` — it extends `BaseModule`), add:

```typescript
/**
 * Per-call tuning for {@link Chat.applyE2EEToOutboundChat}. Defaults preserve
 * the message-body behaviour; body-less signal stanzas (reactions, retract,
 * link previews, easter eggs) override them.
 */
interface E2EEOutboundOptions {
  /** Carry a `<body>` (the plaintextBody arg) inside the encrypted envelope. Default true. */
  encryptBody?: boolean
  /**
   * What to do with the OUTER stanza `<body>` after a successful encrypt:
   *  - 'fallback' (default): replace/insert the plugin's encrypted-fallback string
   *  - 'remove': strip any outer body (pure-signal stanzas)
   */
  outerBody?: 'fallback' | 'remove'
  /** Hint appended after the encrypted element on success. Default 'store'; 'none' appends nothing. */
  storeHint?: 'store' | 'no-store' | 'none'
}
```

- [ ] **Step 2: Add the `options` parameter to the method signature**

Change the signature (currently at `packages/fluux-sdk/src/core/modules/Chat.ts:461-466`) from:

```typescript
  private async applyE2EEToOutboundChat(
    recipient: string,
    plaintextBody: string,
    children: Element[],
    protectedChildKeys?: ReadonlySet<string>,
  ): Promise<MessageSecurityContext | undefined> {
```

to:

```typescript
  private async applyE2EEToOutboundChat(
    recipient: string,
    plaintextBody: string,
    children: Element[],
    protectedChildKeys?: ReadonlySet<string>,
    options?: E2EEOutboundOptions,
  ): Promise<MessageSecurityContext | undefined> {
```

- [ ] **Step 3: Make the envelope body conditional**

Find this line (currently `packages/fluux-sdk/src/core/modules/Chat.ts:488`):

```typescript
      const protectedChildren: Element[] = [xml('body', {}, plaintextBody)]
```

Replace it with:

```typescript
      const encryptBody = options?.encryptBody ?? true
      const protectedChildren: Element[] = encryptBody ? [xml('body', {}, plaintextBody)] : []
```

Then, immediately after the `for` loop that appends matched children (the block ending at the line `const plaintext = serializePayloadEnvelope(protectedChildren)`, currently line ~502), insert a guard BEFORE that `serializePayloadEnvelope` call:

```typescript
      // Body-less callers must contribute at least one protected child; an
      // empty envelope would encrypt nothing. Treat as "no encryption" so the
      // caller's plaintext stanza is sent untouched.
      if (protectedChildren.length === 0) {
        await manager.assertPlaintextPermitted({ kind: 'direct', peer: recipient })
        return undefined
      }
```

- [ ] **Step 4: Make the outer-body rewrite respect `outerBody`**

Find this block (currently `packages/fluux-sdk/src/core/modules/Chat.ts:535-544`):

```typescript
        const bodyIdx = children.findIndex(
          (c): c is Element =>
            typeof c !== 'string' && (c as { name?: string }).name === 'body',
        )
        const fallbackBody = result.payload.fallbackBody ?? '[encrypted message]'
        if (bodyIdx >= 0) {
          children[bodyIdx] = xml('body', {}, fallbackBody)
        } else {
          children.unshift(xml('body', {}, fallbackBody))
        }
```

Replace it with:

```typescript
        const bodyIdx = children.findIndex(
          (c): c is Element =>
            typeof c !== 'string' && (c as { name?: string }).name === 'body',
        )
        if ((options?.outerBody ?? 'fallback') === 'remove') {
          if (bodyIdx >= 0) children.splice(bodyIdx, 1)
        } else {
          const fallbackBody = result.payload.fallbackBody ?? '[encrypted message]'
          if (bodyIdx >= 0) {
            children[bodyIdx] = xml('body', {}, fallbackBody)
          } else {
            children.unshift(xml('body', {}, fallbackBody))
          }
        }
```

- [ ] **Step 5: Make the store hint respect `storeHint`**

Find this line (currently `packages/fluux-sdk/src/core/modules/Chat.ts:569`):

```typescript
        children.push(xml('store', { xmlns: NS_HINTS }))
```

Replace it with:

```typescript
        const storeHint = options?.storeHint ?? 'store'
        if (storeHint !== 'none') {
          children.push(xml(storeHint, { xmlns: NS_HINTS }))
        }
```

- [ ] **Step 6: Run the existing E2EE suite to confirm no behaviour change**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts`
Expected: PASS — all existing tests green (the three existing callers use the defaults, so output is byte-identical to before this task).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no errors. (`E2EEOutboundOptions` is referenced by the new parameter; unused-symbol lint must be clean.)

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts
git commit -m "$(cat <<'EOF'
refactor(e2ee): add E2EEOutboundOptions to applyE2EEToOutboundChat

Lets body-less signal stanzas (reactions, retract, link previews, easter
eggs) reuse the OpenPGP payload envelope. Defaults preserve message-body
behaviour, so existing senders are unchanged.
EOF
)"
```

---

### Task 2: Encrypt reactions (XEP-0444)

`sendReaction` already suppresses the cleartext reply-quote fallback when the peer can be encrypted to, but still publishes the `<reactions>` element (and the reacted-to message id) in cleartext. Move it inside the envelope on that same path.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` — add `E2EE_REACTION_KEYS`; hoist `peerCanEncrypt`; encrypt in the reachable path (`sendReaction`, currently lines ~960-1043)
- Test: `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts` (the `outbound encryption — sendReaction` describe block, currently lines ~1222-1324)

- [ ] **Step 1: Write/Update the failing tests**

In `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts`, **replace** the existing test `it('omits the cleartext reply-quote fallback when the peer can be encrypted to', ...)` (currently lines ~1258-1280) with the version below — its old assertions deliberately asserted the reaction stayed in cleartext, which this task changes:

```typescript
    it('moves the <reactions> element inside the encrypted payload when the peer can be encrypted to', async () => {
      const built = makeDepsWithOriginal({
        manager,
        originalBody: 'super secret original message',
      })
      const reactingChat = new Chat(built.deps, stubMAM())

      await reactingChat.sendReaction('bob@example.com', 'orig-id', ['👍'])

      expect(built.capturedStanzas).toHaveLength(1)
      const sent = built.capturedStanzas[0]

      // No cleartext reaction, no body, no legacy reply machinery on the wire.
      expect(sent.getChild('reactions', 'urn:xmpp:reactions:0')).toBeUndefined()
      expect(sent.getChild('body')).toBeUndefined()
      expect(sent.getChild('reply', 'urn:xmpp:reply:0')).toBeUndefined()

      // Encrypted payload + EME + store hint instead.
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')?.attrs.namespace).toBe(
        'urn:fluux:e2ee-dummy:0',
      )
      expect(sent.getChild('store', 'urn:xmpp:hints')).toBeDefined()
    })

    it('round-trips an encrypted reaction back to a chat:reactions event', async () => {
      // Send encrypted, then replay the captured stanza as if Bob sent it.
      await chat.sendReaction('bob@example.com', 'orig-id', ['👍'])
      const outgoing = captured[0]
      expect(outgoing.getChild('reactions', 'urn:xmpp:reactions:0')).toBeUndefined()

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-react-rt' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxBuilt = makeDeps({ jid: 'me@example.com', manager, captureStanza: () => {} })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const evt = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:reactions',
      ) as { payload: { conversationId: string; messageId: string; emojis: string[] } } | undefined
      expect(evt).toBeDefined()
      expect(evt!.payload.conversationId).toBe('bob@example.com')
      expect(evt!.payload.messageId).toBe('orig-id')
      expect(evt!.payload.emojis).toEqual(['👍'])
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "reactions"`
Expected: FAIL — the new outbound test fails because `<reactions>` is still on the outer stanza (no `<plain>`/EME yet); the round-trip test fails because no `chat:reactions` event fires (the synthetic pass sees the plaintext reaction on the first pass and returns before any encrypt happened, but nothing encrypted it).

- [ ] **Step 3: Add the reaction protected-key set**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, directly below the existing `E2EE_PROTECTED_CHILD_KEYS` static field (currently ends at line ~614), add:

```typescript
  /** XEP-0444 reactions ride inside the envelope; the reacted-to id rides with them. */
  private static readonly E2EE_REACTION_KEYS: ReadonlySet<string> = new Set([
    `reactions|${NS_REACTIONS}`,
  ])
```

- [ ] **Step 4: Hoist `peerCanEncrypt` and encrypt on the reachable path**

In `sendReaction`, find the E2EE-awareness block (currently `packages/fluux-sdk/src/core/modules/Chat.ts:984-995`):

```typescript
    const manager = this.deps.getE2EEManager?.()
    let suppressReplyFallback = false
    if (type === 'chat' && manager) {
      const peerCanEncrypt = await manager
        .canEncryptTo({ kind: 'direct', peer: recipient })
        .catch(() => false)
      if (peerCanEncrypt) {
        suppressReplyFallback = true
      } else if (manager.getSendPolicy() === 'strict') {
        throw new E2EEEncryptionRequiredError({ kind: 'direct', peer: recipient })
      }
    }
```

Replace it with (hoist `peerCanEncrypt` so it is visible after the block):

```typescript
    const manager = this.deps.getE2EEManager?.()
    let suppressReplyFallback = false
    let peerCanEncrypt = false
    if (type === 'chat' && manager) {
      peerCanEncrypt = await manager
        .canEncryptTo({ kind: 'direct', peer: recipient })
        .catch(() => false)
      if (peerCanEncrypt) {
        suppressReplyFallback = true
      } else if (manager.getSendPolicy() === 'strict') {
        throw new E2EEEncryptionRequiredError({ kind: 'direct', peer: recipient })
      }
    }
```

Then find the lines that build the stanza and send it (currently `packages/fluux-sdk/src/core/modules/Chat.ts:1029-1033`):

```typescript
    const reactionStanzaId = generateUUID()
    children.push(createOriginIdElement(reactionStanzaId))

    const message = xml('message', { to: recipient, type, id: reactionStanzaId }, ...children)
    await this.deps.sendStanza(message)
```

Replace with:

```typescript
    const reactionStanzaId = generateUUID()
    children.push(createOriginIdElement(reactionStanzaId))

    // Encrypt the reactions element (and the id it references) for 1:1 chats
    // whenever the peer is E2EE-reachable. A mid-flight plugin failure throws
    // here, blocking a silent plaintext downgrade.
    if (type === 'chat' && peerCanEncrypt) {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_REACTION_KEYS, {
        encryptBody: false,
        outerBody: 'remove',
        storeHint: 'store',
      })
    }

    const message = xml('message', { to: recipient, type, id: reactionStanzaId }, ...children)
    await this.deps.sendStanza(message)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "reactions"`
Expected: PASS — both new tests pass; the existing `strict mode throws…` and `keeps the legacy reply-quote fallback when no E2EE manager is wired` tests still pass (the legacy path is untouched because `peerCanEncrypt` is false there).

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts
git commit -m "$(cat <<'EOF'
feat(e2ee): encrypt reactions inside the OpenPGP payload

XEP-0444 reactions and the message id they reference now ride inside the
encrypted envelope for E2EE-reachable 1:1 peers, instead of leaking to the
server. Legacy/plaintext peers are unchanged.
EOF
)"
```

---

### Task 3: Encrypt retractions (XEP-0424)

`sendRetraction` currently sends `<retract>` plus a fixed English fallback body in cleartext. Encrypt the `<retract>` and replace the retraction-revealing English body with the generic encrypted fallback — while leaving the plaintext path (no E2EE) exactly as today.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` — add `E2EE_RETRACT_KEYS`; refactor `sendRetraction` to build a `children` array and call the helper (currently lines ~1203-1239)
- Test: `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts` (new `outbound encryption — sendRetraction` describe block)

- [ ] **Step 1: Write the failing tests**

In `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts`, add a new describe block after the `outbound encryption — sendReaction` block (before the final closing `})` of the top-level `describe('Chat E2EE wiring', …)`):

```typescript
  describe('outbound encryption — sendRetraction', () => {
    it('encrypts the retract element and hides the retraction notice for E2EE peers', async () => {
      await chat.sendRetraction('bob@example.com', 'orig-id')

      expect(captured).toHaveLength(1)
      const sent = captured[0]

      // The retract element and its target id are inside the encrypted payload.
      expect(sent.getChild('retract', 'urn:xmpp:message-retract:1')).toBeUndefined()
      // The retraction-revealing English body is replaced by the generic fallback.
      expect(sent.getChild('body')?.text()).toBe('[dummy-plaintext payload]')
      // The now-stale <fallback for=NS_RETRACT> is gone.
      const retractFallback = sent
        .getChildren('fallback', 'urn:xmpp:fallback:0')
        .find((el) => el.attrs?.for === 'urn:xmpp:message-retract:1')
      expect(retractFallback).toBeUndefined()
      // Encrypted payload + EME present.
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')).toBeDefined()
    })

    it('round-trips an encrypted retraction back to a chat:message-updated event', async () => {
      await chat.sendRetraction('bob@example.com', 'orig-id')
      const outgoing = captured[0]

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-retract-rt' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxBuilt = makeDeps({ jid: 'me@example.com', manager, captureStanza: () => {} })
      // handleIncomingRetraction needs the original message to confirm the sender.
      rxBuilt.deps.stores = {
        chat: {
          getMessage: () => ({
            id: 'orig-id',
            from: 'bob@example.com',
            body: 'will be retracted',
          } as unknown as import('../types').Message),
        },
      } as unknown as import('../types').StoreBindings
      const rxChat = new Chat(rxBuilt.deps, stubMAM())
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const evt = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message-updated',
      ) as { payload: { messageId: string; updates: { isRetracted?: boolean } } } | undefined
      expect(evt).toBeDefined()
      expect(evt!.payload.messageId).toBe('orig-id')
      expect(evt!.payload.updates.isRetracted).toBe(true)
    })

    it('strict mode throws instead of retracting in plaintext to an unreachable peer', async () => {
      const strictManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      strictManager.setSendPolicy('strict')
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: strictManager,
        captureStanza: (el) => captured.push(el),
      })
      const strictChat = new Chat(deps, stubMAM())

      await expect(
        strictChat.sendRetraction('bob@example.com', 'orig-id'),
      ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
      expect(captured).toHaveLength(0)
    })

    it('keeps the cleartext retraction notice when no E2EE plugin is registered', async () => {
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const plainChat = new Chat(deps, stubMAM())

      await plainChat.sendRetraction('bob@example.com', 'orig-id')

      const sent = captured[0]
      expect(sent.getChild('retract', 'urn:xmpp:message-retract:1')).toBeDefined()
      expect(sent.getChild('body')?.text()).toContain('attempted to retract')
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeUndefined()
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "sendRetraction"`
Expected: FAIL — the first two tests fail (retract still on the outer stanza, English body still present); the strict-mode test fails (no throw yet); the plaintext test passes (current behaviour already matches).

- [ ] **Step 3: Add the retract protected-key set**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, directly below `E2EE_REACTION_KEYS` (added in Task 2), add:

```typescript
  /** XEP-0424 retract element rides inside the envelope; the retracted id rides with it. */
  private static readonly E2EE_RETRACT_KEYS: ReadonlySet<string> = new Set([
    `retract|${NS_RETRACT}`,
  ])
```

- [ ] **Step 4: Refactor `sendRetraction` to build a children array and encrypt**

Replace the body of `sendRetraction` (currently `packages/fluux-sdk/src/core/modules/Chat.ts:1203-1239`) — specifically the stanza-building and send block:

```typescript
    // XEP-0424: Message Retraction with fallback for non-supporting clients
    const fallbackBody = 'This person attempted to retract a previous message, but it\'s unsupported by your client.'

    const retractionStanzaId = generateUUID()
    const message = xml(
      'message',
      { to: recipient, type, id: retractionStanzaId },
      xml('body', {}, fallbackBody),
      xml('retract', { xmlns: NS_RETRACT, id: referenceId }),
      // XEP-0428: Mark the entire body as fallback
      xml('fallback', { xmlns: NS_FALLBACK, for: NS_RETRACT }),
      createOriginIdElement(retractionStanzaId)
    )

    await this.deps.sendStanza(message)
```

with:

```typescript
    // XEP-0424: Message Retraction with fallback for non-supporting clients
    const fallbackBody = 'This person attempted to retract a previous message, but it\'s unsupported by your client.'

    const retractionStanzaId = generateUUID()
    const children: Element[] = [
      xml('body', {}, fallbackBody),
      xml('retract', { xmlns: NS_RETRACT, id: referenceId }),
      // XEP-0428: Mark the entire body as fallback
      xml('fallback', { xmlns: NS_FALLBACK, for: NS_RETRACT }),
      createOriginIdElement(retractionStanzaId),
    ]

    // Encrypt the retract element for 1:1 chats. On success the helper hides
    // the retraction (the English notice is replaced by the generic encrypted
    // fallback and the <fallback for=NS_RETRACT> is dropped); on a mid-flight
    // plugin failure it throws, blocking a silent plaintext downgrade. The
    // plaintext path (no plugin reachable, permissive) keeps the notice.
    if (type === 'chat') {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_RETRACT_KEYS, {
        encryptBody: false,
        outerBody: 'fallback',
        storeHint: 'store',
      })
    }

    await this.deps.sendStanza(
      xml('message', { to: recipient, type, id: retractionStanzaId }, ...children),
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "sendRetraction"`
Expected: PASS — all four tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts
git commit -m "$(cat <<'EOF'
feat(e2ee): encrypt message retractions inside the OpenPGP payload

XEP-0424 retract now rides inside the encrypted envelope for 1:1 E2EE
peers; the retraction-revealing English fallback is replaced by the generic
encrypted fallback so the server can't see that a retraction occurred.
Plaintext conversations keep the legacy notice.
EOF
)"
```

---

### Task 4: Encrypt link previews (XEP-0422 fastening / OGP)

`sendLinkPreview` publishes the Open Graph URL, title, description and image in cleartext. Move the whole `<apply-to>` fastening into the envelope, preserving the `<no-store>` hint in both paths.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` — add `E2EE_FASTEN_KEYS`; refactor `sendLinkPreview` (currently lines ~1312-1337)
- Test: `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts` (new `outbound encryption — sendLinkPreview` describe block)

- [ ] **Step 1: Write the failing tests**

In `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts`, add after the `sendRetraction` describe block:

```typescript
  describe('outbound encryption — sendLinkPreview', () => {
    const preview = {
      url: 'https://secret.example.com/article',
      title: 'Confidential Title',
      description: 'A description the server must not see',
      image: 'https://secret.example.com/preview.jpg',
      siteName: 'Secret Site',
    }

    it('moves the OGP fastening inside the encrypted payload and keeps no-store', async () => {
      await chat.sendLinkPreview('bob@example.com', 'orig-id', preview)

      expect(captured).toHaveLength(1)
      const sent = captured[0]

      // The apply-to fastening (carrying url/title/description/image) is encrypted.
      expect(sent.getChild('apply-to', 'urn:xmpp:fasten:0')).toBeUndefined()
      expect(sent.toString()).not.toContain('Confidential Title')
      expect(sent.toString()).not.toContain('secret.example.com')
      // Encrypted payload + EME, and the no-store hint preserved (not <store>).
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')).toBeDefined()
      expect(sent.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
      expect(sent.getChild('store', 'urn:xmpp:hints')).toBeUndefined()
    })

    it('round-trips an encrypted link preview back to a chat:message-updated event', async () => {
      await chat.sendLinkPreview('bob@example.com', 'orig-id', preview)
      const outgoing = captured[0]

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-ogp-rt' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxBuilt = makeDeps({ jid: 'me@example.com', manager, captureStanza: () => {} })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const evt = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message-updated',
      ) as { payload: { messageId: string; updates: { linkPreview?: { title?: string } } } } | undefined
      expect(evt).toBeDefined()
      expect(evt!.payload.messageId).toBe('orig-id')
      expect(evt!.payload.updates.linkPreview?.title).toBe('Confidential Title')
    })

    it('sends the preview in cleartext (no-store) when no E2EE plugin is registered', async () => {
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const plainChat = new Chat(deps, stubMAM())

      await plainChat.sendLinkPreview('bob@example.com', 'orig-id', preview)

      const sent = captured[0]
      expect(sent.getChild('apply-to', 'urn:xmpp:fasten:0')).toBeDefined()
      expect(sent.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeUndefined()
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "sendLinkPreview"`
Expected: FAIL — the first two tests fail (apply-to still on the outer stanza, no `<plain>`); the plaintext test passes.

- [ ] **Step 3: Add the fastening protected-key set**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, directly below `E2EE_RETRACT_KEYS`, add:

```typescript
  /** XEP-0422 OGP fastening rides inside the envelope (hides url/title/description/image). */
  private static readonly E2EE_FASTEN_KEYS: ReadonlySet<string> = new Set([
    `apply-to|${NS_FASTEN}`,
  ])
```

- [ ] **Step 4: Refactor `sendLinkPreview` to build a children array and encrypt**

Replace the stanza-building and send block in `sendLinkPreview` (currently `packages/fluux-sdk/src/core/modules/Chat.ts:1322-1328`):

```typescript
    const message = xml('message', { to: recipient, type, id: generateUUID() },
      xml('apply-to', { xmlns: NS_FASTEN, id: originalId },
        xml('external', { xmlns: NS_FASTEN, name: 'ogp' }, ...metaElements)
      ),
      xml('no-store', { xmlns: NS_HINTS })
    )
    await this.deps.sendStanza(message)
```

with:

```typescript
    const children: Element[] = [
      xml('apply-to', { xmlns: NS_FASTEN, id: originalId },
        xml('external', { xmlns: NS_FASTEN, name: 'ogp' }, ...metaElements)
      ),
      xml('no-store', { xmlns: NS_HINTS }),
    ]

    // Encrypt the fastening for 1:1 chats so OGP url/title/description/image
    // don't leak to the server. storeHint:'none' keeps the <no-store> we built
    // (encrypted or not); a mid-flight plugin failure throws, blocking a
    // silent plaintext downgrade.
    if (type === 'chat') {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_FASTEN_KEYS, {
        encryptBody: false,
        outerBody: 'remove',
        storeHint: 'none',
      })
    }

    await this.deps.sendStanza(
      xml('message', { to: recipient, type, id: generateUUID() }, ...children),
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "sendLinkPreview"`
Expected: PASS — all three tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts
git commit -m "$(cat <<'EOF'
feat(e2ee): encrypt link previews inside the OpenPGP payload

The XEP-0422 OGP fastening (url, title, description, image) now rides
inside the encrypted envelope for 1:1 E2EE peers instead of leaking the
previewed link's content to the server. The no-store hint is preserved.
EOF
)"
```

---

### Task 5: Encrypt easter eggs

`sendEasterEgg` publishes the animation name in cleartext. Lowest content value, but included for a uniform downgrade guarantee. Preserve `<no-store>` (easter eggs are ephemeral).

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` — add `E2EE_EASTER_EGG_KEYS`; refactor `sendEasterEgg` (currently lines ~1264-1278)
- Test: `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts` (new `outbound encryption — sendEasterEgg` describe block)

- [ ] **Step 1: Write the failing tests**

In `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts`, add after the `sendLinkPreview` describe block:

```typescript
  describe('outbound encryption — sendEasterEgg', () => {
    it('moves the easter-egg element inside the encrypted payload and keeps no-store', async () => {
      await chat.sendEasterEgg('bob@example.com', 'chat', 'confetti')

      expect(captured).toHaveLength(1)
      const sent = captured[0]

      expect(sent.getChild('easter-egg', 'urn:fluux:easter-egg:0')).toBeUndefined()
      expect(sent.toString()).not.toContain('confetti')
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')).toBeDefined()
      expect(sent.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
      expect(sent.getChild('store', 'urn:xmpp:hints')).toBeUndefined()
    })

    it('round-trips an encrypted easter egg back to a chat:animation event', async () => {
      await chat.sendEasterEgg('bob@example.com', 'chat', 'confetti')
      const outgoing = captured[0]

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-egg-rt' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxBuilt = makeDeps({ jid: 'me@example.com', manager, captureStanza: () => {} })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const evt = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:animation',
      ) as { payload: { conversationId: string; animation: string } } | undefined
      expect(evt).toBeDefined()
      expect(evt!.payload.conversationId).toBe('bob@example.com')
      expect(evt!.payload.animation).toBe('confetti')
    })

    it('sends the easter egg in cleartext (no-store) when no E2EE plugin is registered', async () => {
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const plainChat = new Chat(deps, stubMAM())

      await plainChat.sendEasterEgg('bob@example.com', 'chat', 'confetti')

      const sent = captured[0]
      expect(sent.getChild('easter-egg', 'urn:fluux:easter-egg:0')).toBeDefined()
      expect(sent.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeUndefined()
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "sendEasterEgg"`
Expected: FAIL — the first two tests fail (easter-egg still on the outer stanza); the plaintext test passes.

- [ ] **Step 3: Add the easter-egg protected-key set**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, directly below `E2EE_FASTEN_KEYS`, add:

```typescript
  /** Fluux easter-egg animation rides inside the envelope. */
  private static readonly E2EE_EASTER_EGG_KEYS: ReadonlySet<string> = new Set([
    `easter-egg|${NS_EASTER_EGG}`,
  ])
```

- [ ] **Step 4: Refactor `sendEasterEgg` to build a children array and encrypt**

Replace the body of `sendEasterEgg` (currently `packages/fluux-sdk/src/core/modules/Chat.ts:1264-1270`):

```typescript
  async sendEasterEgg(to: string, type: 'chat' | 'groupchat', animation: string): Promise<void> {
    const recipient = type === 'chat' ? getBareJid(to) : to
    const message = xml('message', { to: recipient, type, id: generateUUID() },
      xml('no-store', { xmlns: NS_HINTS }),
      xml('easter-egg', { xmlns: NS_EASTER_EGG, animation })
    )
    await this.deps.sendStanza(message)
```

with:

```typescript
  async sendEasterEgg(to: string, type: 'chat' | 'groupchat', animation: string): Promise<void> {
    const recipient = type === 'chat' ? getBareJid(to) : to
    const children: Element[] = [
      xml('no-store', { xmlns: NS_HINTS }),
      xml('easter-egg', { xmlns: NS_EASTER_EGG, animation }),
    ]

    // Encrypt the animation for 1:1 chats. storeHint:'none' keeps the
    // <no-store> we built; a mid-flight plugin failure throws.
    if (type === 'chat') {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_EASTER_EGG_KEYS, {
        encryptBody: false,
        outerBody: 'remove',
        storeHint: 'none',
      })
    }

    await this.deps.sendStanza(
      xml('message', { to: recipient, type, id: generateUUID() }, ...children),
    )
```

(Leave the rest of the method — the `emitSDK('chat:animation' | 'room:animation', …)` block — unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "sendEasterEgg"`
Expected: PASS — all three tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts
git commit -m "$(cat <<'EOF'
feat(e2ee): encrypt easter-egg animations inside the OpenPGP payload

The animation name now rides inside the encrypted envelope for 1:1 E2EE
peers, with the no-store hint preserved. Plaintext peers are unchanged.
EOF
)"
```

---

### Task 6: Documentation and stale-comment cleanup

Record the widened protection scope and the explicit decision that chat states stay plaintext; fix the now-misleading comment on `E2EE_PROTECTED_CHILD_KEYS`.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` — the doc comment above `E2EE_PROTECTED_CHILD_KEYS` (currently lines ~598-612)
- Modify: `docs/ENCRYPTION.md`

- [ ] **Step 1: Update the stale `E2EE_PROTECTED_CHILD_KEYS` comment**

In `packages/fluux-sdk/src/core/modules/Chat.ts`, find this sentence inside the comment block above `E2EE_PROTECTED_CHILD_KEYS` (currently lines ~608-611):

```
   * Current scope: XEP-0066 OOB + XEP-0446 file-metadata — both of which
   * carry file URL / filename / size / mimetype that would otherwise leak
   * to the XMPP server. Chat states, receipts/markers, LMC, reactions,
   * reply are the planned follow-ups; add them here without other code
   * changes when those PRs land.
```

Replace it with:

```
   * Current scope: XEP-0066 OOB + XEP-0446 file-metadata — both of which
   * carry file URL / filename / size / mimetype that would otherwise leak
   * to the XMPP server. This set is only for extensions that ride alongside
   * a message body. Standalone signal stanzas are encrypted by their own
   * send methods via their own key sets (E2EE_REACTION_KEYS,
   * E2EE_RETRACT_KEYS, E2EE_FASTEN_KEYS, E2EE_EASTER_EGG_KEYS) and LMC is
   * handled inline in sendCorrection. Chat states (XEP-0085) remain
   * plaintext by explicit product decision (see docs/ENCRYPTION.md).
```

- [ ] **Step 2: Document the scope in `docs/ENCRYPTION.md`**

Read `docs/ENCRYPTION.md` to find the section that lists what is / isn't encrypted (search for "OOB" or "metadata" or "payload envelope"). Add a subsection documenting:
- Encrypted in 1:1 now: message body, attachment OOB + file metadata, corrections (LMC), reactions, retractions, link previews (OGP fastening), easter eggs.
- Deliberately plaintext: chat states (XEP-0085 typing notifications) — rationale: pure timing metadata, one crypto op per keystroke is disproportionate, and most E2EE clients leave typing notifications in clear. Revisit if a future threat model requires hiding composition activity.

Use the existing heading style of the file (match the surrounding `##`/`###` levels). Keep it to a short paragraph plus a bullet list — do not restructure the document.

- [ ] **Step 3: Typecheck and run the full E2EE suite**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts && cd ../.. && npm run typecheck`
Expected: PASS — all tests green, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts docs/ENCRYPTION.md
git commit -m "$(cat <<'EOF'
docs(e2ee): document encrypted signal payloads and plaintext chat states

Records that reactions, retractions, link previews and easter eggs now ride
inside the encrypted payload, and that chat states remain plaintext by
explicit decision. Fixes the stale E2EE_PROTECTED_CHILD_KEYS comment.
EOF
)"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire SDK test suite**

Run: `npm test`
Expected: PASS — no failures, no stderr noise. Pay attention to `Chat.test.ts`, `Chat.mam.test.ts`, and `MAM.e2ee.test.ts` (the MAM/archive decrypt path uses the same `stanzaDecrypt`, so encrypted reactions/retractions/previews retrieved from the archive must still round-trip).

- [ ] **Step 2: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 3: Lint (if the repo lints in CI)**

Run: `npm run lint` (skip if no such script exists)
Expected: PASS.

- [ ] **Step 4: Manual sanity note**

Confirm in the diff that none of the four send methods send the protected element at the stanza root when `type === 'chat'` and a plugin is reachable, and that all four still send it at the root for `groupchat` and for plaintext (no-plugin) chats. This is the security-critical invariant.

---

## Self-Review

**Spec coverage** (against the four signals the Codex finding named, plus the helper work):
- Reactions → Task 2. ✓
- Retractions → Task 3. ✓
- Link previews → Task 4. ✓
- Easter eggs → Task 5. ✓
- Helper generalization (body-less, hint control, downgrade guard) → Task 1. ✓
- Chat states explicitly out of scope, documented → Task 6. ✓
- Inbound: verified to need no changes (Background section); MAM/archive covered by Task 7 Step 1. ✓

**Type/name consistency:** `E2EEOutboundOptions` (Task 1) is used identically in Tasks 2–5. Key-set fields `E2EE_REACTION_KEYS` / `E2EE_RETRACT_KEYS` / `E2EE_FASTEN_KEYS` / `E2EE_EASTER_EGG_KEYS` are defined once (Tasks 2–5) and referenced via `Chat.<NAME>` consistently. Option values used (`encryptBody`, `outerBody: 'fallback'|'remove'`, `storeHint: 'store'|'no-store'|'none'`) match the interface. Namespace literals in test assertions match `namespaces.ts`.

**Placeholder scan:** every code step contains complete code; every test step contains full test bodies; every run step has an exact command and expected result. No TBD/TODO.

**Known interop note (not a blocker):** for E2EE peers, reactions/link-previews/easter-eggs are sent with no outer `<body>`, and retractions with a generic `[encrypted message]` body. A non-decrypting third-party client therefore won't render these signals — acceptable, since a non-decrypting client can't read encrypted content anyway, and hiding the metadata from the server is the explicit goal.
