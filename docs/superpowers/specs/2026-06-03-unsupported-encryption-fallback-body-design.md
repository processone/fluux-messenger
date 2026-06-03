# Unsupported-encryption messages: show the fallback body, not a decrypt failure

Date: 2026-06-03

## Problem

Incoming OMEMO messages render as an OpenPGP **decryption failure** — the muted
"Ce message n'a pas pu être déchiffré" placeholder whose tooltip reads "message
chiffré pour une clé qui n'est pas disponible sur cet appareil". This is wrong:
we have no OMEMO plugin at all, so this is not a failed OpenPGP decrypt — it is
an encryption method we do not support yet. The sender's XEP-0380 fallback
`<body>` (e.g. "I sent you an OMEMO encrypted message but your client doesn't
seem to support that…") is hidden, and the placeholder is permanent.

### Root cause

An OMEMO stanza carries an `<encrypted xmlns="eu.siacs.conversations.axolotl">`
child, a XEP-0380 EME hint (`<encryption namespace="eu.siacs.conversations.axolotl" name="OMEMO"/>`),
and a fallback `<body>`. The only registered E2EE plugin is OpenPGP, so:

1. No plugin **claims** the `<encrypted>` child.
2. The EME-detection fallback still fires and **stashes** the payload as
   `message.encryptedPayload` "for deferred retry".
3. The UI renders `EncryptedPlaceholder` instead of the body.
4. `retryPendingDecrypts()` re-attempts on every connect/register/unlock,
   OpenPGP never claims an OMEMO element, the payload is re-stashed, and the
   message is stuck as a misleading decrypt-failure forever.

The two stash sites do not distinguish *"a protocol we support but whose plugin
isn't ready yet"* from *"a protocol we have no plugin for"*:

- Live path: [`Chat.ts:202`](../../../packages/fluux-sdk/src/core/modules/Chat.ts) → `stashEncryptedPayloadForDeferredDecrypt`
- Archive/retry path: [`stanzaDecrypt.ts:154`](../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts) → `stashEncryptedPayloadViaEME`

## Goals

- An EME-tagged message whose protocol no registered plugin handles surfaces its
  sender-supplied fallback `<body>` as a normal message.
- A subtle, muted "encrypted with an unsupported method" hint marks such
  messages (lock icon + tooltip naming the method) so it's clear the content is
  a fallback notice, not plaintext the peer chose to send in the clear.
- Already-received messages currently stuck as decrypt-failure placeholders
  self-heal — not just newly-arriving ones.
- Genuine OpenPGP decrypt failures (key locked, plugin not yet ready) keep their
  existing placeholder + retry behaviour, unchanged.

## Non-goals

- Implementing OMEMO. This change only classifies it as unsupported and shows
  the fallback.
- A placeholder for unsupported-encryption messages that carry **no** body.
  Bodyless messages (OMEMO key-transport / heartbeats) are already dropped by
  the existing `body || OOB || poll` guard at [`Chat.ts:363`](../../../packages/fluux-sdk/src/core/modules/Chat.ts) and never become visible messages — no change needed.
- Changing the `SecurityContext` trust enum.

## Approach

Chosen: **gate EME-based deferred stashing on `E2EEManager.hasPlugins()`.**

Deferred stashing exists for the *"E2EE subsystem isn't ready yet"* race (a
supported plugin finishing async init after a message arrives). Once **any**
plugin is registered and an EME-tagged stanza is *still* unclaimed, the protocol
is one we have no plugin for → unsupported. In the reported screenshot OpenPGP
is registered and unlocked, so OMEMO is confidently classified as unsupported.

Alternatives rejected:

- **Static SDK allowlist of supported EME namespaces.** Bakes app-level plugin
  knowledge (the OpenPGP plugin lives in `apps/fluux/`, not the SDK core) into
  the SDK and must be hand-maintained.
- **Descriptor-declared EME namespaces queried on the manager.** Cleanest
  long-term, but reintroduces the startup race: an OpenPGP message arriving
  before its plugin registers would be misclassified as unsupported and never
  retried.

The `hasPlugins()` gate respects SDK/app layering, needs no hand-maintained
list, and self-heals the sub-second startup window via the existing retry pass.

## Design

### 1. SDK — one classification decision point

Consolidate the two near-duplicate EME helpers into a single classifier in the
e2ee module (`stanzaDecrypt.ts`):

```ts
export type UnclaimedEMEDisposition =
  | { kind: 'retry'; encryptedPayloadXml: string }              // subsystem not ready
  | { kind: 'unsupported'; info: UnsupportedEncryptionInfo }    // ready, nothing claims it
  | null                                                        // no EME hint (cleartext)

export function classifyUnclaimedEME(
  stanza: Element,
  hasPlugins: boolean,
): UnclaimedEMEDisposition
```

- No EME hint → `null`.
- `hasPlugins === false` → `{ kind: 'retry', encryptedPayloadXml }` (locate the
  encrypted child by matching the EME `namespace`, serialize it).
- `hasPlugins === true` → `{ kind: 'unsupported', info }`.

Both call sites use it:

- **Live path** ([`Chat.ts:202`](../../../packages/fluux-sdk/src/core/modules/Chat.ts)):
  replaces the direct `stashEncryptedPayloadForDeferredDecrypt` call. Passes
  `!!manager?.hasPlugins()`. On `retry` → stash payload (existing behaviour); on
  `unsupported` → stash the unsupported-encryption info on the stanza.
- **Archive/retry path** (`decryptStanzaInPlace` no-claim branch,
  [`stanzaDecrypt.ts:148`](../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts)):
  same, using `manager.hasPlugins()`. The result is surfaced via
  `DecryptInPlaceResult` (see §3).

`stashEncryptedPayloadForDeferredDecrypt` (Chat) and `stashEncryptedPayloadViaEME`
(stanzaDecrypt) collapse into the shared classifier + stash helpers, removing the
duplicated EME-namespace-matching logic.

### 2. SDK — EME namespace → display name

A small map in the e2ee module:

```ts
const EME_PROTOCOL_NAMES: Record<string, string> = {
  'eu.siacs.conversations.axolotl': 'OMEMO',
  'urn:xmpp:omemo:2': 'OMEMO 2',
  'urn:xmpp:openpgp:0': 'OpenPGP',
  'jabber:x:encrypted': 'Legacy OpenPGP',
  'urn:xmpp:otr:0': 'OTR',
}
```

Display name = `EME_PROTOCOL_NAMES[ns] ?? emeEl.attrs.name ?? ns`.

### 3. SDK — new message field

Add to the base message type ([`message-base.ts`](../../../packages/fluux-sdk/src/core/types/message-base.ts)),
a sibling to `encryptedPayload` / `securityContext`:

```ts
export interface UnsupportedEncryptionInfo {
  /** XEP-0380 EME namespace, e.g. `eu.siacs.conversations.axolotl`. */
  namespace: string
  /** Human-readable protocol name (known-namespace map, EME `name` attr, or raw ns). */
  name: string
}

/**
 * Set when an incoming message used an E2EE protocol this client has no plugin
 * for. Unlike `encryptedPayload` there is nothing to retry — the SDK surfaces
 * the sender's XEP-0380 fallback `<body>` verbatim and tags the message so the
 * UI can show a muted "unsupported method" hint.
 */
unsupportedEncryption?: UnsupportedEncryptionInfo
```

Stashed on the stanza (new `__unsupportedEncryption` stash + `readStashedUnsupportedEncryption`
reader, mirroring the existing encrypted-payload stash) and read at the three
message-construction sites:

- [`Chat.ts:1915`](../../../packages/fluux-sdk/src/core/modules/Chat.ts) (live chat)
- [`MAM.ts:1747`](../../../packages/fluux-sdk/src/core/modules/MAM.ts) (archived chat)
- [`MAM.ts:1815`](../../../packages/fluux-sdk/src/core/modules/MAM.ts) (archived room)

The fallback `body` is already stored alongside (`processChatMessage` always sets
`body: parsed.processedBody`), so no other change is needed at these sites.

### 4. SDK — retry self-heal (doubles as migration)

`decryptStanzaInPlace` returns the unsupported disposition via a new optional
field on `DecryptInPlaceResult`:

```ts
unsupportedEncryption?: UnsupportedEncryptionInfo
```

`retryDecryptSingle` gains an explicit "unsupported" outcome (replacing the
current `null`-means-everything return with a small discriminated result):

```ts
type RetryOutcome =
  | { kind: 'decrypted'; body: string; securityContext?: MessageSecurityContext; attachment?: FileAttachment }
  | { kind: 'unsupported'; info: UnsupportedEncryptionInfo }
  | { kind: 'pending' }   // still can't decrypt — keep encryptedPayload
```

`retryPendingDecrypts()` and `retryPendingDecryptsForPeer()` handle `unsupported`
by updating the stored message to `{ encryptedPayload: undefined, unsupportedEncryption: info }`,
leaving `body` untouched. Because these passes already iterate every stored
message carrying `encryptedPayload` on each connect/register/unlock, this
**converts already-received stuck messages** the next time they run — the
migration for existing data falls out for free.

### 5. App — UI

In the MessageBubble header-indicator slot ([`MessageBubble.tsx:430`](../../../apps/fluux/src/components/conversation/MessageBubble.tsx)),
where `securityContext` renders a trust-colored lock, add a mutually-exclusive
branch:

```tsx
{message.securityContext ? (
  /* existing trust lock */
) : message.unsupportedEncryption ? (
  <Tooltip content={t('chat.encryption.unsupportedMethodTooltip', { method: message.unsupportedEncryption.name })} position="top" triggerMode="click">
    <span className="flex items-center text-fluux-muted" aria-label={...}>
      <Lock className="size-3" />
    </span>
  </Tooltip>
) : null}
```

The body renders normally through `MessageBody` (no `encryptedPayload` is set, so
the line-483 `EncryptedPlaceholder` branch is not taken — untouched). Add
`unsupportedEncryption` to the memo comparator ([`MessageBubble.tsx:158`](../../../apps/fluux/src/components/conversation/MessageBubble.tsx)),
mirroring how `securityContext` is compared, so the indicator updates on
self-heal.

### 6. i18n

One new key, translated into all 33 locales (per project convention — no English
placeholders):

```
chat.encryption.unsupportedMethodTooltip:
  EN: "Encrypted with {{method}} — a method this device doesn't support yet"
  FR: "Chiffré avec {{method}} — méthode non prise en charge sur cet appareil"
```

## Edge cases

- **No fallback body** (OMEMO key-transport / heartbeat): already dropped at
  [`Chat.ts:363`](../../../packages/fluux-sdk/src/core/modules/Chat.ts); never
  emitted. No change, no placeholder, no noise.
- **Startup-race window** (EME message arrives before any plugin registers):
  stashed for retry as today; on the next retry pass, `hasPlugins()` is true and
  the message self-heals to `unsupportedEncryption`.
- **Genuine OpenPGP failure** (key locked / plugin mid-init): unchanged —
  `encryptedPayload` is set and `EncryptedPlaceholder` renders as before.

## Testing

SDK (Vitest):

- `classifyUnclaimedEME`: no-EME → null; `hasPlugins=false` → retry+payload;
  `hasPlugins=true` → unsupported+info; name resolution (map / `name` attr / raw ns).
- `decryptStanzaInPlace`: unclaimed EME child with `hasPlugins=true` →
  `{ attempted:false, unsupportedEncryption }`, no `encryptedPayloadXml`, fallback
  `<body>` left intact.
- Chat live path: OMEMO stanza with OpenPGP registered → message carries
  `unsupportedEncryption` + fallback body, **no** `encryptedPayload`.
- Retry self-heal: a stored message with `encryptedPayload` (OMEMO) →
  `retryPendingDecrypts` clears `encryptedPayload`, sets `unsupportedEncryption`,
  preserves body.

App (Vitest + Testing Library):

- MessageBubble renders the fallback body + muted-lock hint when
  `unsupportedEncryption` is set; tooltip names the method.
- Regression: `encryptedPayload` still renders `EncryptedPlaceholder`.

## Files touched

SDK:
- `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts` — classifier, EME name map, no-claim branch, result field
- `packages/fluux-sdk/src/core/types/message-base.ts` — `UnsupportedEncryptionInfo`, `unsupportedEncryption` field
- `packages/fluux-sdk/src/core/modules/Chat.ts` — live-path classify, read stash at construction
- `packages/fluux-sdk/src/core/modules/MAM.ts` — read stash at chat + room construction
- `packages/fluux-sdk/src/core/XMPPClient.ts` — `retryDecryptSingle` outcome + retry-loop handling
- `packages/fluux-sdk/src/core/e2ee/index.ts` / types export as needed

App:
- `apps/fluux/src/components/conversation/MessageBubble.tsx` — header indicator + memo comparator
- `apps/fluux/src/i18n/locales/*.json` — new key in all 33 locales

Tests:
- `stanzaDecrypt.test.ts`, `Chat.e2ee.test.ts`, XMPPClient/MAM tests as applicable
- `MessageBubble.test.tsx`
