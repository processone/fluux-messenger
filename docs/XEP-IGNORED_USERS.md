# Proto-XEP: Per-Room Ignored Users via PEP

**Namespace:** `urn:xmpp:fluux:ignored-users:0`
**Dependencies:** XEP-0223 (Persistent Storage of Private Data via PubSub), XEP-0060 (Publish-Subscribe)
**Status:** Experimental (client-side implementation)

---

## 1. Introduction

This document describes a protocol for storing per-room user ignore lists as private data on the XMPP server. Each user maintains their own set of ignored users for each MUC room they participate in. The data is stored via XEP-0223 (Private PEP Storage) so it is private to the owner and synced across their clients.

### 1.1 Motivation

Ignoring disruptive users in a group chat is a common need. By storing ignore lists server-side via PEP, the ignored state is preserved across sessions and synchronized across multiple clients without requiring any server-side module.

---

## 2. Requirements

- The server MUST support XEP-0163 (Personal Eventing Protocol) with XEP-0223 publish-options.
- The client MUST support XEP-0060 (Publish-Subscribe) IQ operations.

---

## 3. Data Model

Ignored user lists are stored as items in a PEP node named `urn:xmpp:fluux:ignored-users:0`. Each item represents one room, using the room's bare JID as the item ID. The item contains an `<ignored-users>` element with one `<user>` child per ignored user.

### 3.1 `<ignored-users>` Element

Container element in the `urn:xmpp:fluux:ignored-users:0` namespace. Contains zero or more `<user>` children.

### 3.2 `<user>` Element

| Attribute    | Type   | Required | Description                                                                 |
|--------------|--------|----------|-----------------------------------------------------------------------------|
| `identifier` | string | Yes      | Stable user identifier (XEP-0421 occupant ID or bare JID).                |
| `name`       | string | Yes      | Display name for the ignored user (for UI rendering without room presence). |
| `jid`        | string | No       | User's bare JID, if known. May be absent in anonymous rooms.               |

---

## 4. Operations

### 4.1 Fetch Ignored Users for a Room

Retrieve the ignore list for a specific room by requesting the item whose ID matches the room JID:

```xml
<iq type="get" to="user@example.com" id="ignored_12345">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <items node="urn:xmpp:fluux:ignored-users:0">
      <item id="room@conference.example.com"/>
    </items>
  </pubsub>
</iq>
```

**Response:**

```xml
<iq type="result" to="user@example.com/resource" id="ignored_12345">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <items node="urn:xmpp:fluux:ignored-users:0">
      <item id="room@conference.example.com">
        <ignored-users xmlns="urn:xmpp:fluux:ignored-users:0">
          <user identifier="occ-abc123" name="Alice" jid="alice@example.com"/>
          <user identifier="occ-def456" name="Bob"/>
        </ignored-users>
      </item>
    </items>
  </pubsub>
</iq>
```

If the node or item does not exist, the server returns an error. Clients SHOULD treat this as an empty ignore list.

### 4.2 Set Ignored Users for a Room

Publish the complete ignore list for a room, replacing any previous data:

```xml
<iq type="set" id="ignored_set_67890">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <publish node="urn:xmpp:fluux:ignored-users:0">
      <item id="room@conference.example.com">
        <ignored-users xmlns="urn:xmpp:fluux:ignored-users:0">
          <user identifier="occ-abc123" name="Alice" jid="alice@example.com"/>
          <user identifier="occ-def456" name="Bob"/>
        </ignored-users>
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

### 4.3 Remove Ignored Users for a Room

When the ignore list for a room becomes empty, retract the item:

```xml
<iq type="set" id="ignored_remove_12345">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <retract node="urn:xmpp:fluux:ignored-users:0">
      <item id="room@conference.example.com"/>
    </retract>
  </pubsub>
</iq>
```

---

## 5. Privacy

- The PEP node uses `access_model=whitelist`, ensuring only the node owner can read or write their ignore lists.
- Other users cannot discover who is ignoring them.
- Ignored users are filtered client-side; the server delivers all messages normally.

---

## 6. Namespace

The protocol uses the namespace `urn:xmpp:fluux:ignored-users:0`. The `:0` suffix indicates an experimental version.
