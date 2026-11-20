# Proto-XEP: Saved Messages via PEP

**Namespace:** `urn:xmpp:fluux:saved-messages:0`
**Dependencies:** XEP-0223 (Persistent Storage of Private Data via PubSub), XEP-0060 (Publish-Subscribe), XEP-0297 (Stanza Forwarding), XEP-0203 (Delayed Delivery), XEP-0359 (Unique and Stable Stanza IDs)
**Optional:** XEP-0421 (Occupant Identifiers for MUC)
**Status:** Experimental (client-side implementation)

---

## 1. Introduction

No XMPP extension covers saving (bookmarking) a single message. XEP-0402 saves rooms, and XEP-0490 records one read position per conversation. This document describes how Fluux keeps a user's saved messages on a private PEP node, one item per saved message, so every client of the account lists the same set and can open the original in its conversation.

A saved entry is a private copy, never verified history. Opening an entry goes to the real message, which wins on any difference.

---

## 2. Requirements

- The server MUST support XEP-0163 (PEP) with XEP-0223 `publish-options`.
- A client that wants live updates advertises `urn:xmpp:fluux:saved-messages:0+notify` in its entity capabilities.

---

## 3. Node

The node `urn:xmpp:fluux:saved-messages:0` is created on the first publish with these `publish-options`:

| Field                             | Value       |
|-----------------------------------|-------------|
| `pubsub#persist_items`            | `true`      |
| `pubsub#access_model`             | `whitelist` |
| `pubsub#max_items`                | `256`       |
| `pubsub#send_last_published_item` | `never`     |

Only the publish that may create the node carries `pubsub#max_items`. Every later publish (a new save, or the rewrite of a deleted entry) carries the other three fields alone, so a server that enforces publish-option preconditions does not refuse it on a node that exists with another limit. If the creating publish is refused, the client repeats it once without `pubsub#max_items`; the node then takes the service's default, and the client reads the effective `pubsub#max_items` from the owner configuration afterwards (§3.2) before it sends anything more.

### 3.1 Item id

The item id is opaque: a reader never parses it. It depends on whether the account has an OpenPGP key (§7):

- **OpenPGP off:** a hash of the message identity (the conversation JID, then the XEP-0359 archive id with its `by`, else the origin id, else the client id). Two devices saving the same message publish the same item.
- **OpenPGP on:** a random UUID without dashes, chosen by the saving client. A hash would let the server recompute which message an item names. Two devices that save one message at once publish two items; each client shows the message once and retracts the weaker one (§5, Duplicates).

### 3.2 Server limit

Servers cap a node and silently drop the oldest item past the cap (Prosody `pep_max_items`, 256 by default; ejabberd `max_items_node`, 1000 by default). The creating publish asks for 256 items, a number a service with a lower ceiling refuses or lowers; a node set to `max` would not say how many it keeps. A client reads the effective `pubsub#max_items` from the node's owner configuration and does not publish an item that would exceed it.

---

## 4. Payload

```xml
<item id="b7e1a0c4d2f9...">
  <saved xmlns="urn:xmpp:fluux:saved-messages:0" stamp="2026-11-19T14:05:00Z">
    <forwarded xmlns="urn:xmpp:forward:0">
      <delay xmlns="urn:xmpp:delay" stamp="2026-11-12T10:42:00Z"/>
      <message xmlns="jabber:client" from="team@conference.example/Alice"
               type="groupchat" id="m1">
        <body>The release checklist is in the wiki.</body>
        <stanza-id xmlns="urn:xmpp:sid:0" id="1731490000123456" by="team@conference.example"/>
        <origin-id xmlns="urn:xmpp:sid:0" id="o1"/>
        <occupant-id xmlns="urn:xmpp:occupant-id:0" id="occ-alice"/>
      </message>
    </forwarded>
  </saved>
</item>
```

### 4.1 `<saved/>`

| Attribute   | Required | Description                                                          |
|-------------|----------|----------------------------------------------------------------------|
| `stamp`     | Yes      | When the message was saved (XEP-0082 date-time).                     |
| `encrypted` | No       | `"true"` when the original was end-to-end encrypted; no body is stored. |
| `deleted`   | No       | `"true"` when the original was retracted or moderated; no body is kept. An item with no body and no `deleted` is a message that never had text (an attachment, for example). |

It holds exactly one XEP-0297 `<forwarded/>`. A client that rewrites an item MUST keep every other child element it does not understand, so tags and other data can be added later without a new node.

### 4.2 The forwarded copy

With OpenPGP off the copy is written in the clear, as below. With OpenPGP on, nothing of it is written in the clear: see §4.3.

- `<delay stamp/>` is the time the original was sent.
- `<message from to type id/>` is the original. In a room, `from` is the occupant JID and `type` is `groupchat`. In a one-to-one chat, `from` and `to` are the two bare JIDs and `type` is `chat`.
- The conversation is the room's bare JID, or the bare JID in `from`/`to` that is not the account's own.
- `<stanza-id by id/>` (XEP-0359) is the archive id when known: the room for a room message, the account for a one-to-one message. A message just sent has none until the client learns it from the archive or a carbon.
- `<origin-id/>` and `<occupant-id/>` (XEP-0421, rooms only) are included when known.
- `<body/>` holds the plain text, at most 4000 characters, and only when the message was not end-to-end encrypted. Control characters and direction overrides are removed on read.

### 4.3 Sealed items

While the account has an OpenPGP key, an item carries one `<sealed/>` child and nothing else:

```xml
<item id="5b0e6c1f6e0a4f3e8f1d2c3b4a596877">
  <saved xmlns="urn:xmpp:fluux:saved-messages:0">
    <sealed>LS0tLS1CRUdJTiBQR1AgTUVTU0FHRS0tLS0t...</sealed>
  </saved>
</item>
```

`<sealed/>` holds the base64 of an armored OpenPGP message, signed with the account's own key and encrypted to that key alone, as the verification sync does: a reader accepts only the own primary key's signature, so another key could not use what it was given. Its plaintext is one JSON object `{"v":1,"entry":{...}}`. The entry holds every field the clear form has: `conversationJid`, `type`, `from`, `to`, `text` (up to 4000 code points), `encrypted`, `deleted`, `sentAt`, `savedAt`, `messageId`, `stanzaId`, `stanzaIdBy`, `originId`, `occupantId` and the unknown children kept as `extras`. The server therefore sees the item id, the size and the time of the write, and nothing about the message or its conversation.

A reader opens a sealed item only if the account's own primary key signed it. An item that is unsigned, signed by another key, unreadable, or whose payload is not an entry is not listed. It still counts against the node's limit. A client that cannot open sealed items (the key is locked, or this device has none) lists none of them: the list is locked until the key is available (§7).

An end-to-end encrypted original that this device decrypted keeps its text in the sealed entry, so the Saved view shows it on every device and after the archive expired. A message still waiting for its key is saved without text.

Fluux builds the copy with the same function Forward uses and reads it with a reader that adds the identity elements to the bounds Forward's reader applies. Forward's own reader is unchanged; it reads the original's id and stanza-id that Forward now carries and ignores every other extension.

---

## 5. Operations

- **Save:** publish the item. **Remove:** retract it, asking the server to notify subscribers (`notify="true"`). Only `item-not-found` counts as a removal that is already done; any other refusal puts the item back in the list and tells the person.
- **Node limit:** a client sends nothing before it has read the node, and refuses a new save that would take the node past its `pubsub#max_items`, because the server would silently drop the oldest item. A node configured with `max` says nothing of the number, so its limit stays unknown. The count is the items the server is known to hold (listed, notified or acknowledged), so a removal the server has not yet taken, or one it refused, still counts. A publish the server took counts even when a newer local change replaced it. When the limit cannot be read, only the first item of a node that does not exist yet is sent; the rest wait until it can.
- **Fetch:** `<items node="urn:xmpp:fluux:saved-messages:0"/>` on the own account. Only an answered fetch (items, or `item-not-found`) replaces the local list; a refused or unanswered fetch leaves it as it is. Changes made or notified while the fetch is in flight win over its answer, and copies of originals already known to be deleted (from the retraction ledger or from a retracted copy in the device's cache) arrive without their text. One read owns the list at a time: a newer read supersedes an older one, and a read that outlived a local-data wipe is dropped, as is a notification that was waiting during one. A removal recovered after a reload keeps the server's copy, so a refusal can bring the row back without another read.
- **Notify:** other online clients receive the item or retract through `+notify` and apply it without reloading.
- **Offline:** a save or removal made while disconnected is shown at once, kept on the device across a reload, and sent on reconnect.
- **Identity:** two entries are one message when the client's message-identity rules say so: the archive id with its `by`, else the origin id, else the client id, each scoped to its author. Two room messages sharing a sender-chosen origin id but with different archive ids or occupants stay separate.
- **Duplicates:** entries naming the same message (one saved before the archive id was known, one after) are shown once; the weaker one is retracted.
- **Deleted originals:** when the client learns the original was retracted or moderated, the client republishes the item with `deleted="true"` and no body, and the row shows "Message deleted". The retraction is the one the client has validated and stored, so a retraction of a closed conversation counts as much as one in the open window. A row shows the latest copy in the device's cache, so a received edit shows too.

---

## 6. Opening an entry

The client looks for the message in the resident history, then in its cache, then asks the archive by exact archive id (rooms: the room archive; one-to-one: the account archive). An entry without an archive id falls back to a time-window query around the sent time. A lookup that confirms the message is gone reads "no longer available"; a failed query reads "could not load" and offers a retry, never a deletion claim.

Prosody keeps its archive one week by default, so an entry can outlive the archive copy of its message; a plain entry still shows its saved text.

---

## 7. Privacy

A `whitelist` node keeps other users out, not the server operator. 
### 7.1 OpenPGP off

Plain messages store their text, which the server's archive already holds. Encrypted messages store no body, and the Saved row reads "Encrypted message" until this device finds the decrypted copy.


### 7.2 OpenPGP on

Every entry, plain or encrypted, is sealed (§4.3). This replaces the earlier plan to seal only encrypted messages: the server's archive holds plain text, but a saved list also tells the server which messages the account cares about, and sealing hides that.

- **Locked list.** Sealing needs the key. While a key exists but cannot be used (the web app until the backup code is typed, a refused keychain), the list shows a locked notice and no rows; items, plain ones included, are held back, and a save waits in the offline queue instead of being written in clear. Unlocking reads the node again.
- **Not known yet.** The OpenPGP plugin joins some time after the session starts. Until it does, an account that sealed the last time it was known is treated as locked, so a save made or queued across a restart is never written in clear; the memory is dropped when the person turns OpenPGP off in the app or clears local data.
- **No key on this device.** Sealed items stay locked and plain items show as they did.
- **Authorship.** The signature, not the access model, is what a reader trusts: a server can encrypt to the account's public key but cannot sign as its owner.
- **Not covered.** A signature per item does not stop the server from dropping an item, or from replaying one the account removed. The size of an item and the number of items remain visible.
- **Losing the key loses the entries.** The server holds nothing a lost key can recover; they are as recoverable as the OpenPGP backup code.
- **Plain items beside sealed ones.** A plain item read while OpenPGP is on is listed flagged "Not verified": nothing proves the account wrote it. The first time a client reads a node that holds no sealed item at all, it seals every plain item under a new random id and retracts the plain ones, so entries from before OpenPGP was on carry over. Once a sealed item exists, plain items are never sealed automatically; a plain item a server adds stays flagged until removed.
- **Deleted originals.** The republished item is sealed; its entry carries `deleted: true` and no text, as in §5.

The format follows the verification sync (`urn:xmpp:fluux:verifications:1`), which signs and encrypts to the own key in the same way. XEP-0510 (End-to-End Encrypted Contacts Metadata) builds on XEP-0473, a shared symmetric key per node with unsigned items; for a node only its owner reads, encrypting to the owner's own key does the same job and signs each item.

---

## 8. Namespace

`urn:xmpp:fluux:saved-messages:0` (node and payload), `urn:xmpp:fluux:saved-messages:0+notify` (capability).
