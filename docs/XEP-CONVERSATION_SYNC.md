# Proto-XEP: Conversation List Sync via PEP

**Namespace:** `urn:xmpp:fluux:conversations:0`
**Dependencies:** XEP-0223 (Persistent Storage of Private Data via PubSub), XEP-0060 (Publish-Subscribe)
**Status:** Experimental (client-side implementation)

---

## 1. Introduction

This document describes a protocol for synchronizing a user's 1:1 conversation list across multiple XMPP clients. The conversation list — including which conversations are active or archived — is stored as private data via XEP-0223, allowing any connected client to retrieve and update it.

### 1.1 Motivation

XMPP does not natively maintain a persistent list of 1:1 conversations. While MAM (XEP-0313) can be used to discover recent conversations, it does not track user intent such as archived/active status. This extension provides a lightweight sync mechanism for the conversation list itself, without duplicating message content.

---

## 2. Requirements

- The server MUST support XEP-0163 (Personal Eventing Protocol) with XEP-0223 publish-options.
- The client MUST support XEP-0060 (Publish-Subscribe) IQ operations.

---

## 3. Data Model

The conversation list is stored as a single PEP item (id=`"current"`) in the node `urn:xmpp:fluux:conversations:0`. The item contains a `<conversations>` element with one `<conversation>` child per entry.

### 3.1 `<conversations>` Element

Container element in the `urn:xmpp:fluux:conversations:0` namespace. Contains zero or more `<conversation>` children.

### 3.2 `<conversation>` Element

| Attribute  | Type    | Required | Description                                                           |
|------------|---------|----------|-----------------------------------------------------------------------|
| `jid`      | string  | Yes      | Bare JID of the conversation partner.                                |
| `archived` | boolean | No       | If `"true"`, the conversation is archived. Absent or `"false"` means active. |

Only the JID and archived flag are synced. Display names, avatars, and other metadata are derived locally from the roster or vCard.

---

## 4. Operations

### 4.1 Fetch Conversation List

Retrieve the current conversation list:

```xml
<iq type="get" to="user@example.com" id="conv_list_12345">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <items node="urn:xmpp:fluux:conversations:0">
      <item id="current"/>
    </items>
  </pubsub>
</iq>
```

**Response:**

```xml
<iq type="result" to="user@example.com/resource" id="conv_list_12345">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <items node="urn:xmpp:fluux:conversations:0">
      <item id="current">
        <conversations xmlns="urn:xmpp:fluux:conversations:0">
          <conversation jid="alice@example.com"/>
          <conversation jid="bob@example.com" archived="true"/>
          <conversation jid="carol@example.com"/>
        </conversations>
      </item>
    </items>
  </pubsub>
</iq>
```

If the node or item does not exist, the server returns an error. Clients SHOULD treat this as an empty conversation list.

### 4.2 Publish Conversation List

Publish the full conversation list, replacing any previous data. This is a complete replacement — there is no delta or incremental update mechanism.

```xml
<iq type="set" id="conv_list_set_67890">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <publish node="urn:xmpp:fluux:conversations:0">
      <item id="current">
        <conversations xmlns="urn:xmpp:fluux:conversations:0">
          <conversation jid="alice@example.com"/>
          <conversation jid="bob@example.com" archived="true"/>
          <conversation jid="carol@example.com"/>
        </conversations>
      </item>
    </publish>
    <publish-options>
      <x xmlns="jabber:x:data" type="submit">
        <field var="FORM_TYPE" type="hidden">
          <value>http://jabber.org/protocol/pubsub#publish-options</value>
        </field>
        <field var="pubsub#persist_items">
          <value>true</value>
        </field>
        <field var="pubsub#access_model">
          <value>whitelist</value>
        </field>
      </x>
    </publish-options>
  </pubsub>
</iq>
```

---

## 5. Design Notes

### 5.1 Full Replacement Model

Each publish replaces the entire conversation list. This keeps the protocol simple and avoids conflict resolution for concurrent edits from multiple clients. The trade-off is that large conversation lists produce larger stanzas, but in practice this is manageable (hundreds of JIDs at most).

### 5.2 Scope

This protocol covers 1:1 conversations only. MUC room membership is managed via XEP-0402 (PEP Native Bookmarks).

### 5.3 Archived vs. Deleted

The `archived` flag allows users to hide conversations from their active list without deleting them. This preserves the conversation for future reference while keeping the inbox clean.

---

## 6. Privacy

- The PEP node uses `access_model=whitelist`, ensuring only the owner can read or write their conversation list.
- The list contains only bare JIDs and archived flags — no message content or metadata.

---

## 7. Namespace

The protocol uses the namespace `urn:xmpp:fluux:conversations:0`. The `:0` suffix indicates an experimental version.
