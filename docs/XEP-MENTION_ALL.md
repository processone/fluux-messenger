# Proto-XEP: Room-Wide @all Mentions

**Namespace:** `urn:fluux:mentions:0`
**Dependencies:** XEP-0372 (References)
**Status:** Experimental (client-side implementation)

---

## 1. Introduction

This document describes a simple protocol extension for marking room-wide @all mentions in XMPP Multi-User Chat (MUC) messages. It adds a `<mention-all>` flag element alongside standard XEP-0372 references so that receiving clients can quickly detect messages addressed to the entire room without parsing the message body.

### 1.1 Motivation

XEP-0372 (References) provides a mechanism for mentioning individual users by URI. However, it has no built-in concept of an @all mention — a mention that targets every participant in a room. This extension fills that gap with a minimal flag element that clients can use for notification filtering and UI highlighting.

---

## 2. Requirements

- The sending client MUST support XEP-0372 (References) for individual mentions.
- The MUC room MUST support `type="groupchat"` messages.

---

## 3. Protocol

### 3.1 Sending

When a user includes an @all mention in a groupchat message, the sending client adds an empty `<mention-all>` element in the `urn:fluux:mentions:0` namespace to the message stanza.

The @all mention is also represented as a XEP-0372 `<reference>` element whose `uri` attribute points to the room JID without a resource (i.e., no `/` path component), indicating the mention targets the room itself rather than a specific occupant.

### 3.2 XML Schema

```xml
<message to="room@conference.example.com" type="groupchat" id="msg-123">
  <body>@all please check this</body>

  <reference xmlns="urn:xmpp:reference:0"
             begin="0"
             end="4"
             type="mention"
             uri="xmpp:room@conference.example.com"/>

  <mention-all xmlns="urn:fluux:mentions:0"/>
</message>
```

### 3.3 `<mention-all>` Element

The `<mention-all>` element is an empty element with no attributes and no child elements. Its presence indicates the message contains a room-wide mention.

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)*  | —    | —        | Empty element; presence is the signal. |

### 3.4 Receiving

When a client receives a groupchat message, it detects @all mentions using the following logic:

1. **Element check (preferred):** If the stanza contains `<mention-all xmlns="urn:fluux:mentions:0"/>`, the message is an @all mention.
2. **Text fallback:** If the element is absent, the client MAY fall back to regex detection (`/@all\b/i`) on the message body to support legacy senders.

The element check takes precedence. The text fallback ensures interoperability with clients that type `@all` but do not implement this extension.

---

## 4. Integration with XEP-0372

The @all mention integrates naturally with XEP-0372 references:

- **Individual mentions:** `<reference uri="xmpp:room@conference.example.com/nickname"/>` — URI includes a resource (occupant nickname).
- **Room-wide mention:** `<reference uri="xmpp:room@conference.example.com"/>` — URI points to the bare room JID (no `/` path). This reference triggers the `<mention-all>` element.

Both types can coexist in the same message (e.g., `@all and @alice`).

---

## 5. Use Cases

### 5.1 Notification Filtering

Clients use the `<mention-all>` flag to determine notification priority. A message mentioning @all may warrant a higher-priority notification (e.g., sound, badge) compared to regular room messages.

### 5.2 UI Highlighting

The @all mention can trigger visual highlighting in the message list, similar to individual @mentions but applied to all room participants.

---

## 6. Namespace

The protocol uses the namespace `urn:fluux:mentions:0`. The `:0` suffix indicates an experimental version.
