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
| `pubsub#max_items`                | `max`       |
| `pubsub#send_last_published_item` | `never`     |

### 3.1 Item id

The item id is a hash of the message identity: the conversation JID, then the XEP-0359 archive id with its `by`, else the origin id, else the client id. Two devices saving the same message publish the same item. The id is opaque; a reader never parses it.

### 3.2 Server limit

Servers cap a node and silently drop the oldest item past the cap (Prosody `pep_max_items`, 256 by default; ejabberd `max_items_node`, 1000 by default). A client reads the effective `pubsub#max_items` from the node's owner configuration and does not publish an item that would exceed it.

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

It holds exactly one XEP-0297 `<forwarded/>`. A client that rewrites an item MUST keep every other child element it does not understand, so tags and other data can be added later without a new node.

### 4.2 The forwarded copy

- `<delay stamp/>` is the time the original was sent.
- `<message from to type id/>` is the original. In a room, `from` is the occupant JID and `type` is `groupchat`. In a one-to-one chat, `from` and `to` are the two bare JIDs and `type` is `chat`.
- The conversation is the room's bare JID, or the bare JID in `from`/`to` that is not the account's own.
- `<stanza-id by id/>` (XEP-0359) is the archive id when known: the room for a room message, the account for a one-to-one message. A message just sent has none until the client learns it from the archive or a carbon.
- `<origin-id/>` and `<occupant-id/>` (XEP-0421, rooms only) are included when known.
- `<body/>` holds the plain text, at most 4000 characters, and only when the message was not end-to-end encrypted. Control characters and direction overrides are removed on read.

Fluux builds the copy with the same function Forward uses and reads it with a reader that adds the identity elements to the bounds Forward's reader applies. Forward's own reader is unchanged and keeps ignoring every extension.

---

## 5. Operations

- **Save:** publish the item. **Remove:** retract it.
- **Fetch:** `<items node="urn:xmpp:fluux:saved-messages:0"/>` on the own account. Only an answered fetch (items, or `item-not-found`) replaces the local list; a refused or unanswered fetch leaves it as it is.
- **Notify:** other online clients receive the item or retract through `+notify` and apply it without reloading.
- **Offline:** a save or removal made while disconnected is shown at once, kept on the device across a reload, and sent on reconnect.
- **Duplicates:** entries naming the same message (one saved before the archive id was known, one after) are shown once; the weaker one is retracted.
- **Deleted originals:** when the client learns the original was retracted or moderated, the row shows "Message deleted" and the client republishes the item without its body.

---

## 6. Opening an entry

The client looks for the message in the resident history, then in its cache, then asks the archive by exact archive id (rooms: the room archive; one-to-one: the account archive). An entry without an archive id falls back to a time-window query around the sent time. A lookup that confirms the message is gone reads "no longer available"; a failed query reads "could not load" and offers a retry, never a deletion claim.

Prosody keeps its archive one week by default, so an entry can outlive the archive copy of its message; a plain entry still shows its saved text.

---

## 7. Privacy

A `whitelist` node keeps other users out, not the server operator. Plain messages store their text, which the server's archive already holds; encrypted messages store no body. XEP-0510 shows a way to encrypt private PEP data; keeping an encrypted message's OpenPGP payload in the copy is a possible later step.

---

## 8. Namespace

`urn:xmpp:fluux:saved-messages:0` (node and payload), `urn:xmpp:fluux:saved-messages:0+notify` (capability).
