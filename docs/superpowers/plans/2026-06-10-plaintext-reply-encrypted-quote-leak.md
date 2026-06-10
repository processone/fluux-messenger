# Plaintext-Reply Encrypted-Quote Leak Protection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the decrypted body of an encrypted message from leaking in cleartext when the user replies to it without encryption — strip the quote from the wire, keep reply threading, and tell the user in the composer.

**Architecture:** The SDK is the security boundary. `Chat.sendMessage` already builds the XEP-0461 reply quote into the outgoing body *before* the encryption step. When the send ends up encrypted, the quote rides safely inside the `<payload/>`. When it ends up cleartext, a new post-encryption guard strips the quote block from the outer `<body>` and drops the `<fallback for="urn:xmpp:reply:0">` marker (keeping the `<reply/>` reference). The app passes a `fromEncrypted` flag (derived from the source message's `securityContext`/`encryptedPayload`) so the SDK knows the quote is sensitive, and renders a one-line notice in the reply banner.

**Tech Stack:** TypeScript, `@xmpp/client` (ltx `xml()` element builder), Vitest, React, react-i18next (33 locales).

**Spec:** [docs/superpowers/specs/2026-06-10-plaintext-reply-encrypted-quote-leak-design.md](../specs/2026-06-10-plaintext-reply-encrypted-quote-leak-design.md)

---

## File Structure

- **`packages/fluux-sdk/src/core/modules/Chat.ts`** (modify) — extend the `replyTo.fallback` param type with `fromEncrypted?`, add a private `stripEncryptedReplyQuoteFromCleartext()` helper, and call it after the E2EE step in `sendMessage`.
- **`packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts`** (modify) — three integration tests covering the strip, the no-strip-when-encrypted regression, and the no-strip-when-source-was-cleartext regression.
- **`apps/fluux/src/utils/replyEncryption.ts`** (create) — pure predicate `isEncryptedSource(message)` reused for both the wire flag and the UI notice (DRY).
- **`apps/fluux/src/utils/replyEncryption.test.ts`** (create) — unit tests for the predicate.
- **`apps/fluux/src/components/ChatView.tsx`** (modify) — set `fromEncrypted` on the reply fallback passed to `sendMessage`; compute `replyQuoteHidden` and pass it to the composer.
- **`apps/fluux/src/components/MessageComposer.tsx`** (modify) — add optional `replyQuoteHidden` prop; render the notice instead of the quote body in the reply banner.
- **`apps/fluux/src/i18n/locales/*.json`** (modify, 33 files) — add `chat.replyQuoteHiddenEncrypted`.

---

## Task 1: SDK — strip the quote from a cleartext reply to an encrypted message

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Chat.ts` (signature ~`:700`, helper near `:646`, call-site after `:830`)
- Test: `packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `Chat.e2ee.test.ts`, inside the top-level `describe('Chat E2EE wiring', () => { ... })` (e.g. right after the existing `describe('outbound encryption', ...)` block). It reuses the file's existing `chat`, `captured`, `makeDeps`, `stubXmppPrimitives`, `stubMAM`, `E2EEManager`, `InMemoryStorageBackend`, and `Chat` from the top of the file.

```typescript
  describe('reply-quote leak protection (cleartext reply to an encrypted message)', () => {
    const encryptedReply = {
      id: 'orig',
      to: 'bob@example.com',
      fallback: { author: 'Bob', body: 'the code is 4471', fromEncrypted: true },
    }

    it('strips the quote from the outer body when the reply is sent in CLEARTEXT', async () => {
      // Fresh manager with no plugins → the send goes out unencrypted.
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

      await plainChat.sendMessage('bob@example.com', 'sure thing', 'chat', encryptedReply)

      const sent = captured[0]
      const body = sent.getChild('body')?.text() ?? ''
      // The decrypted quote must NOT appear in the cleartext body.
      expect(body).not.toContain('4471')
      expect(body).not.toContain('> Bob wrote:')
      expect(body).toBe('sure thing')

      // The reply fallback marker is dropped (its [0, end) region no longer exists)…
      const replyFallback = sent
        .getChildren('fallback', 'urn:xmpp:fallback:0')
        .find((el) => el.attrs?.for === 'urn:xmpp:reply:0')
      expect(replyFallback).toBeUndefined()

      // …but the reply reference itself survives so threading / jump-to still works.
      const reply = sent.getChild('reply', 'urn:xmpp:reply:0')
      expect(reply).toBeDefined()
      expect(reply?.attrs.id).toBe('orig')
    })

    it('keeps the quote INSIDE the encrypted payload when the reply is encrypted', async () => {
      // `chat` uses the DummyPlaintextPlugin (registered in beforeEach) → encrypts.
      await chat.sendMessage('bob@example.com', 'sure thing', 'chat', encryptedReply)

      const sent = captured[0]
      // Outer body is the generic fallback, never the quote.
      expect(sent.getChild('body')?.text()).toBe('[dummy-plaintext payload]')
      expect(sent.getChild('body')?.text()).not.toContain('4471')

      // The reply fallback marker is preserved on the encrypted path.
      const replyFallback = sent
        .getChildren('fallback', 'urn:xmpp:fallback:0')
        .find((el) => el.attrs?.for === 'urn:xmpp:reply:0')
      expect(replyFallback).toBeDefined()

      // The quote still reaches the recipient — it is inside the encrypted payload.
      const enc = sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')
      expect(enc).toBeDefined()
      const decoded = Buffer.from(enc!.text(), 'base64').toString('utf8')
      expect(decoded).toContain('4471')
    })

    it('does NOT strip a cleartext reply to a cleartext message (no regression)', async () => {
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

      await plainChat.sendMessage('bob@example.com', 'sure thing', 'chat', {
        id: 'orig',
        to: 'bob@example.com',
        fallback: { author: 'Bob', body: 'hello there' }, // fromEncrypted omitted → false
      })

      const sent = captured[0]
      const body = sent.getChild('body')?.text() ?? ''
      // The quote is preserved exactly as today.
      expect(body).toContain('> Bob wrote:')
      expect(body).toContain('hello there')
      const replyFallback = sent
        .getChildren('fallback', 'urn:xmpp:fallback:0')
        .find((el) => el.attrs?.for === 'urn:xmpp:reply:0')
      expect(replyFallback).toBeDefined()
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts -t "reply-quote leak protection"`
Expected: the first test FAILS — the cleartext body still contains `4471` / `> Bob wrote:` and the reply fallback is still present (no strip implemented yet). The other two should already pass (they describe current behavior), confirming the tests are wired correctly.

- [ ] **Step 3: Extend the `replyTo` parameter type**

In `Chat.ts`, in the `sendMessage` signature (around line 700), add `fromEncrypted?: boolean` to the fallback shape:

```typescript
  async sendMessage(
    to: string,
    body: string,
    type: 'chat' | 'groupchat' = 'chat',
    replyTo?: { id: string; to?: string; fallback?: { author: string; body: string; fromEncrypted?: boolean } },
    references?: MentionReference[],
    attachment?: FileAttachment
  ): Promise<string> {
```

- [ ] **Step 4: Add the private strip helper**

In `Chat.ts`, add this method just above the `E2EE_PROTECTED_CHILD_KEYS` declaration (around line 644, right after `applyE2EEToOutboundChat` ends at line 625). It mutates `children` in place.

```typescript
  /**
   * Privacy guard (E2EE): a XEP-0461 reply quote is built from the *displayed*
   * body of the message being replied to. If that source message arrived
   * encrypted, its body is decrypted plaintext, and the outgoing `<body/>`
   * now carries that plaintext as a `> … wrote:` quote.
   *
   * On the ENCRYPTED send path the quote rode safely inside the `<payload/>`
   * (the outer body was replaced with a generic fallback by
   * {@link applyE2EEToOutboundChat}). On the CLEARTEXT path it would leak the
   * original message on the wire, in server MAM, and via carbons. This strips
   * the quote block out of the outer body and removes the reply fallback
   * marker, while keeping the `<reply/>` reference so threading still works.
   *
   * `fallbackEnd` is the length of the leading quote block in `fullBody`
   * (`[0, fallbackEnd)`). OOB fallback offsets, if present, shift left by the
   * same amount so a supporting client still hides the correct URL region.
   */
  private stripEncryptedReplyQuoteFromCleartext(
    children: Element[],
    ctx: {
      fullBody: string
      fallbackEnd: number
      hasAttachment: boolean
      oobFallbackStart: number
      oobFallbackEnd: number
    },
  ): void {
    const { fullBody, fallbackEnd, hasAttachment, oobFallbackStart, oobFallbackEnd } = ctx
    if (fallbackEnd <= 0) return

    const strippedBody = fullBody.slice(fallbackEnd)
    const bodyIdx = children.findIndex(
      (c): c is Element => typeof c !== 'string' && (c as Element).name === 'body',
    )
    if (bodyIdx >= 0) children[bodyIdx] = xml('body', {}, strippedBody)

    const replyFallbackIdx = children.findIndex(
      (c) =>
        typeof c !== 'string' &&
        (c as Element).name === 'fallback' &&
        (c as Element).attrs?.for === NS_REPLY,
    )
    if (replyFallbackIdx >= 0) children.splice(replyFallbackIdx, 1)

    if (hasAttachment) {
      const oobFallbackIdx = children.findIndex(
        (c) =>
          typeof c !== 'string' &&
          (c as Element).name === 'fallback' &&
          (c as Element).attrs?.for === NS_OOB,
      )
      if (oobFallbackIdx >= 0) {
        children[oobFallbackIdx] = xml(
          'fallback',
          { xmlns: NS_FALLBACK, for: NS_OOB },
          xml('body', {
            start: String(oobFallbackStart - fallbackEnd),
            end: String(oobFallbackEnd - fallbackEnd),
          }),
        )
      }
    }
  }
```

- [ ] **Step 5: Call the helper after the E2EE step in `sendMessage`**

In `Chat.ts`, immediately after the `applyE2EEToOutboundChat` assignment block (after line 830, before the attachment-encryption guard at line 832), insert:

```typescript
    // Never let a quote decrypted from an encrypted message ride in a
    // cleartext body. Only relevant for 1:1 chat (MUC has no E2EE) and only
    // when the send actually went out unencrypted (no security context).
    if (type === 'chat' && !outgoingSecurityContext && replyTo?.fallback?.fromEncrypted) {
      this.stripEncryptedReplyQuoteFromCleartext(children, {
        fullBody,
        fallbackEnd,
        hasAttachment: !!attachment,
        oobFallbackStart,
        oobFallbackEnd,
      })
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.e2ee.test.ts`
Expected: PASS — all tests in the file, including the new `reply-quote leak protection` block.

- [ ] **Step 7: Typecheck the SDK and rebuild it**

Run: `cd packages/fluux-sdk && npx tsc --noEmit && cd ../.. && npm run build:sdk`
Expected: no type errors; SDK build succeeds. (Rebuild is required so the app picks up the new `fromEncrypted` field on the `sendMessage` type — see the project memory note "After changing SDK types, rebuild SDK before app typecheck".)

- [ ] **Step 8: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/Chat.ts packages/fluux-sdk/src/core/modules/Chat.e2ee.test.ts
git commit -m "fix(e2ee): strip reply quote from cleartext reply to an encrypted message"
```

---

## Task 2: App — derive `fromEncrypted` with a reusable predicate

**Files:**
- Create: `apps/fluux/src/utils/replyEncryption.ts`
- Test: `apps/fluux/src/utils/replyEncryption.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/replyEncryption.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { isEncryptedSource } from './replyEncryption'

describe('isEncryptedSource', () => {
  it('is true when the message was decrypted (securityContext present)', () => {
    expect(isEncryptedSource({ securityContext: { protocolId: 'openpgp', trust: 'verified' } })).toBe(true)
  })

  it('is true when the message is still pending decrypt (encryptedPayload present)', () => {
    expect(isEncryptedSource({ encryptedPayload: '<message/>' })).toBe(true)
  })

  it('is false for a plaintext message (neither field present)', () => {
    expect(isEncryptedSource({})).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/replyEncryption.test.ts`
Expected: FAIL — `Failed to resolve import "./replyEncryption"` (module not created yet).

- [ ] **Step 3: Create the predicate**

Create `apps/fluux/src/utils/replyEncryption.ts`:

```typescript
import type { Message } from '@fluux/sdk'

/**
 * A message arrived end-to-end encrypted if it was successfully decrypted
 * (`securityContext` set) or is still awaiting a deferred decrypt
 * (`encryptedPayload` set). Used to decide whether quoting it in a cleartext
 * reply would leak the original — see Chat.sendMessage's strip guard.
 */
export function isEncryptedSource(
  message: Pick<Message, 'securityContext' | 'encryptedPayload'>,
): boolean {
  return !!(message.securityContext || message.encryptedPayload)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/replyEncryption.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire `fromEncrypted` into the reply sent by `ChatView`**

In `apps/fluux/src/components/ChatView.tsx`, add the import near the other util imports (top of file):

```typescript
import { isEncryptedSource } from '@/utils/replyEncryption'
```

Then update the `replyTo` construction (currently lines 1057–1061) to set `fromEncrypted`:

```typescript
      replyTo = {
        id: replyingTo.id,
        to: replyingTo.from,
        fallback: { author: authorName, body: replyingTo.body, fromEncrypted: isEncryptedSource(replyingTo) }
      }
```

- [ ] **Step 6: Typecheck the app**

Run: `npm run typecheck`
Expected: no errors. (If it complains that `fromEncrypted` is not assignable, the SDK was not rebuilt — re-run `npm run build:sdk`.)

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/utils/replyEncryption.ts apps/fluux/src/utils/replyEncryption.test.ts apps/fluux/src/components/ChatView.tsx
git commit -m "feat(e2ee): mark replies to encrypted messages so the SDK strips the cleartext quote"
```

---

## Task 3: i18n — add the reply-banner notice string to all 33 locales

**Files:**
- Modify: `apps/fluux/src/i18n/locales/*.json` (33 files)

- [ ] **Step 1: Add the key to every locale**

In each locale file, add a `replyQuoteHiddenEncrypted` entry to the `chat` object (place it next to the existing `"reply"` key). Use the translation for that locale from the table below. Example for `en.json` — find the line `"reply": "Reply",` inside `"chat": {` and add the new line after it:

```json
        "reply": "Reply",
        "replyQuoteHiddenEncrypted": "Quote hidden — original was encrypted",
```

Translation table (value per locale file):

| File | Value |
|------|-------|
| `en.json` | `Quote hidden — original was encrypted` |
| `ar.json` | `تم إخفاء الاقتباس — كانت الرسالة الأصلية مُشفَّرة` |
| `be.json` | `Цытата схаваная — арыгінал быў зашыфраваны` |
| `bg.json` | `Цитатът е скрит — оригиналът беше шифрован` |
| `ca.json` | `Cita amagada — l'original estava xifrat` |
| `cs.json` | `Citace skryta — originál byl šifrovaný` |
| `da.json` | `Citat skjult — originalen var krypteret` |
| `de.json` | `Zitat ausgeblendet – Original war verschlüsselt` |
| `el.json` | `Το απόσπασμα αποκρύφθηκε — το αρχικό ήταν κρυπτογραφημένο` |
| `es.json` | `Cita oculta: el original estaba cifrado` |
| `et.json` | `Tsitaat peidetud — originaal oli krüpteeritud` |
| `fi.json` | `Lainaus piilotettu — alkuperäinen oli salattu` |
| `fr.json` | `Citation masquée — le message d'origine était chiffré` |
| `ga.json` | `Athfhriotal i bhfolach — bhí an bunteachtaireacht criptithe` |
| `he.json` | `הציטוט הוסתר — המקור היה מוצפן` |
| `hr.json` | `Citat skriven — izvornik je bio šifriran` |
| `hu.json` | `Idézet elrejtve — az eredeti titkosított volt` |
| `is.json` | `Tilvitnun falin — upprunalega skeytið var dulkóðað` |
| `it.json` | `Citazione nascosta — l'originale era cifrato` |
| `lt.json` | `Citata paslėpta — originalas buvo užšifruotas` |
| `lv.json` | `Citāts paslēpts — oriģināls bija šifrēts` |
| `mt.json` | `Kwotazzjoni moħbija — l-oriġinal kien ikkriptat` |
| `nb.json` | `Sitat skjult — originalen var kryptert` |
| `nl.json` | `Citaat verborgen — origineel was versleuteld` |
| `pl.json` | `Cytat ukryty — oryginał był zaszyfrowany` |
| `pt.json` | `Citação oculta — o original estava cifrado` |
| `ro.json` | `Citat ascuns — originalul era criptat` |
| `ru.json` | `Цитата скрыта — оригинал был зашифрован` |
| `sk.json` | `Citácia skrytá — originál bol šifrovaný` |
| `sl.json` | `Citat skrit — izvirnik je bil šifriran` |
| `sv.json` | `Citat dolt — originalet var krypterat` |
| `uk.json` | `Цитату приховано — оригінал був зашифрований` |
| `zh-CN.json` | `引用已隐藏 — 原始消息已加密` |

- [ ] **Step 2: Verify the JSON is valid and the key is present in every file**

Run: `cd apps/fluux/src/i18n/locales && for f in *.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8')).chat.replyQuoteHiddenEncrypted || (console.error('MISSING in $f'), process.exit(1))" || exit 1; done && echo "all 33 OK"`
Expected: prints `all 33 OK` with no `MISSING`/parse errors.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/i18n/locales
git commit -m "i18n(chat): add reply-quote-hidden notice for encrypted-source replies"
```

---

## Task 4: App — render the notice in the reply banner

**Files:**
- Modify: `apps/fluux/src/components/MessageComposer.tsx` (props ~`:84`, banner ~`:677`)
- Modify: `apps/fluux/src/components/ChatView.tsx` (compute + pass `replyQuoteHidden`, near `:1004` and `:1119`)

- [ ] **Step 1: Add the `replyQuoteHidden` prop to `MessageComposer`**

In `MessageComposer.tsx`, in the props interface, add the prop right after the existing `onCancelReply` declaration (around line 86):

```typescript
  /** Callback when reply is cancelled */
  onCancelReply?: () => void
  /** When true, the reply quote is hidden because the source message was encrypted and this reply is plaintext */
  replyQuoteHidden?: boolean
```

- [ ] **Step 2: Destructure the new prop**

In `MessageComposer.tsx`, find where props are destructured in the component body (the list that includes `replyingTo,` around line 161) and add `replyQuoteHidden,` to it:

```typescript
  replyingTo,
  onCancelReply,
  replyQuoteHidden,
```

- [ ] **Step 3: Render the notice instead of the quote body**

In `MessageComposer.tsx`, replace the quote-body paragraph in the reply preview (currently lines 684–686):

```tsx
            <p className="text-xs text-fluux-muted truncate">
              {replyingTo.body}
            </p>
```

with a conditional that shows the notice when the quote is hidden:

```tsx
            {replyQuoteHidden ? (
              <p className="text-xs text-fluux-muted italic truncate flex items-center gap-1">
                <Lock className="size-3 flex-shrink-0" />
                {t('chat.replyQuoteHiddenEncrypted')}
              </p>
            ) : (
              <p className="text-xs text-fluux-muted truncate">
                {replyingTo.body}
              </p>
            )}
```

(`Lock` and `t` are already imported/available in `MessageComposer.tsx`.)

- [ ] **Step 4: Compute and pass `replyQuoteHidden` from `ChatView`**

In `ChatView.tsx`, just after the `replyInfo` definition (after line 1011), add:

```typescript
  // Show a banner notice when the reply will be sent in cleartext but the
  // quoted message arrived encrypted — the SDK strips the quote in that case.
  // `keyLocked` is excluded: the send is blocked until unlock, then encrypts.
  const replyQuoteHidden =
    !!replyingTo &&
    encryptionState.kind !== 'encrypted' &&
    encryptionState.kind !== 'keyLocked' &&
    isEncryptedSource(replyingTo)
```

Then pass it to the composer where `replyingTo={replyInfo}` is set (line 1119):

```tsx
        replyingTo={replyInfo}
        onCancelReply={onCancelReply}
        replyQuoteHidden={replyQuoteHidden}
```

(`isEncryptedSource` was imported in Task 2, Step 5.)

- [ ] **Step 5: Typecheck and run the affected app tests**

Run: `npm run typecheck`
Expected: no errors.

Run: `cd apps/fluux && npx vitest run src/components/MessageInput.memo.test.tsx src/components/RoomMessageInput.memo.test.tsx`
Expected: PASS — the new prop is optional, so existing composer tests are unaffected.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/ChatView.tsx
git commit -m "feat(e2ee): show 'quote hidden' notice when replying in cleartext to an encrypted message"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full SDK + app test suites**

Run: `cd packages/fluux-sdk && npx vitest run` then `cd ../../apps/fluux && npx vitest run`
Expected: all pass, no stderr. (Per project memory, do not run bare `vitest` from the repo root — it mass-fails app tests on `@/` aliases. Run each workspace separately.)

- [ ] **Step 2: Typecheck + lint the whole repo**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 3: Manual smoke (optional, demo mode)**

If verifying in the browser: `npm run dev`, open the demo, open an encrypted conversation, disable encryption for it, reply to one of the earlier (encrypted) messages, and confirm the composer shows "Quote hidden — original was encrypted" and the sent message contains no quoted text. (Demo mode has no real E2EE; this primarily exercises the UI notice path. The wire-strip behavior is covered by the SDK tests in Task 1.)

---

## Self-Review Notes

- **Spec coverage:** SDK strip on cleartext path (Task 1) ✓; app supplies `fromEncrypted` from `securityContext`/`encryptedPayload` (Task 2) ✓; banner notice (Tasks 3–4) ✓; reply reference preserved / fallback dropped (Task 1 tests) ✓; encrypted path unchanged (Task 1 regression test) ✓; 1:1-only gating via `type === 'chat'` (Task 1, Step 5) ✓; i18n across 33 locales (Task 3) ✓.
- **Type consistency:** `fromEncrypted` is the same name in the SDK param (Task 1), the app call-site (Task 2), and conceptually in `isEncryptedSource`. `replyQuoteHidden` is the same prop name in `MessageComposer` (Task 4 Steps 1–3) and the `ChatView` call-site (Task 4 Step 4). Helper name `stripEncryptedReplyQuoteFromCleartext` is used identically in declaration and call-site.
- **Edge case (reply + unencrypted attachment + plaintext):** handled — the body is `fullBody.slice(fallbackEnd)` (preserves the URL tail) and the OOB fallback offsets shift left by `fallbackEnd`. An *encrypted* attachment can never reach this branch (the `attachment?.encryption && !outgoingSecurityContext` guard at Chat.ts:835 throws first).
