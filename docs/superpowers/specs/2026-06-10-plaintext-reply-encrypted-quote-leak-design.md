# Design: Prevent encrypted-message leak via plaintext reply fallback

**Date:** 2026-06-10
**Status:** Approved (design)

## Problem

When a user replies to a message that arrived **encrypted** (OpenPGP E2EE), and the
reply itself is sent **without encryption**, the decrypted plaintext of the original
message leaks in the clear.

The reply fallback quote (XEP-0461 / XEP-0428) is built from the *displayed* body of
the message being replied to. For an encrypted message that body is the
already-decrypted plaintext:

- `apps/fluux/src/components/ChatView.tsx:1054` builds
  `replyTo.fallback = { author, body: replyingTo.body }`. `replyingTo.body` is the
  decrypted plaintext; the message's `securityContext` marker is never consulted.
- `packages/fluux-sdk/src/core/modules/Chat.ts:709` prepends the quote to the outgoing
  body: `fullBody = "> {author} wrote:\n> {quoted}\n" + body`.
- `applyE2EEToOutboundChat()` then runs:
  - **Encrypted reply (safe):** the whole `fullBody` — quote included — goes inside the
    OpenPGP `<payload>`, and the outer cleartext `<body>` is replaced with
    `[encrypted message]`. No leak.
  - **Plaintext reply (the leak):** when the conversation is not encrypting
    (`encryptionState` is `plaintextForced`, `disabled`, `unsupported`, …),
    `applyE2EEToOutboundChat` does nothing and `fullBody` *is* the cleartext `<body>`
    on the wire — quote included.

The leaked quote is not just transient on-wire exposure: it is persisted in server-side
**MAM**, synced via **carbons** to the user's other devices, and stored in the
recipient's cleartext history — exactly the exposure E2EE was meant to prevent.

**Most reliable trigger:** encrypted history exists with a contact, the user disables
encryption for that conversation (or the master toggle is off), then replies to one of
the earlier encrypted messages.

Scope note: 1:1 chat only today — `applyE2EEToOutboundChat` is gated on `type === 'chat'`
and MUC rooms have no E2EE yet.

## Hard constraint

A cleartext outgoing `<body>` must **never** embed content decrypted from an encrypted
message. "Send anyway with the quote" is never an option; the quote is always stripped
from the wire in the leak case.

## Approach (chosen: SDK-enforced strip, app supplies signal + notice)

The SDK is the security boundary (per CLAUDE.md: the SDK owns "all XMPP protocol logic").
The guard lives in the SDK so every consumer — the Fluux app, bots, demo — is protected,
not just one UI path. The app supplies the provenance signal it already has at the reply
site and renders the user-facing notice.

Considered and rejected:
- **App strips before `sendMessage`** — puts leak-prevention in UI code; SDK consumers
  reusing the reply API get no protection.
- **SDK fully self-enforcing via message-cache lookup of `replyTo.id`** — most robust but
  the source message isn't always resolvable (scrolled-out / evicted) and it couples send
  to cache state. Good hardening follow-up, overkill for v1.

### Trigger condition

Outgoing message is **not** encrypted **and** the replied-to message is an encrypted
message — i.e. it carries `securityContext` (decrypted) or still-pending `encryptedPayload`.

### SDK — `Chat.sendMessage` (`packages/fluux-sdk/src/core/modules/Chat.ts:696`)

- Extend the `replyTo.fallback` parameter with `fromEncrypted?: boolean`.
- After `applyE2EEToOutboundChat` returns: if `outgoingSecurityContext` is `undefined`
  (the send went out plaintext) **and** `replyTo.fallback.fromEncrypted` is true:
  - set the `<body>` child to just the user's `body` (drop the `> … wrote:` quote block);
  - skip pushing the `<fallback for="urn:xmpp:reply:0">` element;
  - keep the `<reply id="…">` reference element so threading / jump-to still works on the
    recipient side.
- Encrypted path: unchanged — the quote rides inside the `<payload>` and the outer body
  becomes `[encrypted message]`.

### App — `ChatView.tsx` (`apps/fluux/src/components/ChatView.tsx:1054`)

- Set `fromEncrypted: !!(replyingTo.securityContext || replyingTo.encryptedPayload)` on the
  fallback passed to `sendMessage`.
- In the composer's reply banner (reply preview), when
  `encryptionState.kind !== 'encrypted'` and the source message is encrypted, render a
  subtle inline notice before sending: **"Quote hidden — original was encrypted."**

## Testing (TDD)

**SDK (`Chat` reply tests / `Chat.e2ee.test.ts`):**
- Plaintext reply with `fromEncrypted: true` → outgoing `<body>` has no `>` quote and no
  `<fallback>` element; `<reply>` reference is present.
- Encrypted reply with `fromEncrypted: true` → quote inside the `<payload>`, outer body
  `[encrypted message]` (regression guard for the existing safe path).
- Plaintext reply with `fromEncrypted: false` (cleartext reply to a cleartext message) →
  quote present exactly as today (no regression).

**App (`ChatView` tests):**
- `fromEncrypted` derived correctly from `replyingTo.securityContext` / `encryptedPayload`.
- Reply-banner notice shows only on the mismatch (plaintext send + encrypted source).

## Scope / YAGNI

- Replies only. Link previews are already gated on encryption
  (`apps/fluux/src/components/ChatView.tsx:1096`); there is no forward feature; copy is
  OS-level.
- MUC is naturally unaffected (MUC messages aren't encrypted yet).
- Cache-lookup self-enforcement (Approach C) deferred as a possible hardening follow-up.
