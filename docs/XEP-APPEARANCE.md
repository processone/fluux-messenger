# Proto-XEP: Appearance Settings via PEP

**Namespace:** `urn:xmpp:fluux:appearance:0`
**Dependencies:** XEP-0223 (Persistent Storage of Private Data via PubSub), XEP-0060 (Publish-Subscribe)
**Status:** Experimental (client-side implementation)

---

## 1. Introduction

This document describes a protocol for storing user appearance and theme preferences as private data on the XMPP server. Settings are stored via XEP-0223 (Private PEP Storage) so they are synchronized across all of the user's clients.

### 1.1 Motivation

Users expect their theme preferences (light mode, dark mode, system default) to follow them across devices and sessions. By storing appearance settings server-side via PEP, any client can retrieve the user's preference on login without local storage or manual reconfiguration.

---

## 2. Requirements

- The server MUST support XEP-0163 (Personal Eventing Protocol) with XEP-0223 publish-options.
- The client MUST support XEP-0060 (Publish-Subscribe) IQ operations.

---

## 3. Data Model

Appearance settings are stored as a single PEP item (id=`"current"`) in the node `urn:xmpp:fluux:appearance:0`. The item contains an `<appearance>` element with child elements for each setting.

### 3.1 `<appearance>` Element

Container element in the `urn:xmpp:fluux:appearance:0` namespace.

### 3.2 Child Elements

| Element  | Type   | Required | Description                                                        |
|----------|--------|----------|--------------------------------------------------------------------|
| `<mode>` | string | Yes      | Appearance mode. Values: `"light"`, `"dark"`, `"system"`.          |

Additional settings may be added as child elements in future versions.

---

## 4. Operations

### 4.1 Fetch Appearance Settings

Retrieve the current settings:

```xml
<iq type="get" to="user@example.com" id="appearance_12345">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <items node="urn:xmpp:fluux:appearance:0" max_items="1"/>
  </pubsub>
</iq>
```

**Response:**

```xml
<iq type="result" to="user@example.com/resource" id="appearance_12345">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <items node="urn:xmpp:fluux:appearance:0">
      <item id="current">
        <appearance xmlns="urn:xmpp:fluux:appearance:0">
          <mode>dark</mode>
        </appearance>
      </item>
    </items>
  </pubsub>
</iq>
```

If the node does not exist, the server returns an error. Clients SHOULD fall back to a default appearance mode (e.g., `"system"`).

### 4.2 Set Appearance Settings

Publish updated settings:

```xml
<iq type="set" id="appearance_67890">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <publish node="urn:xmpp:fluux:appearance:0">
      <item id="current">
        <appearance xmlns="urn:xmpp:fluux:appearance:0">
          <mode>dark</mode>
        </appearance>
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

## 5. Backwards Compatibility

Early versions of the protocol used a `<theme>` child element instead of `<mode>`. Clients SHOULD read both `<mode>` (preferred) and `<theme>` (legacy fallback) when parsing. New publishes MUST use `<mode>`.

---

## 6. Privacy

- The PEP node uses `access_model=whitelist`, ensuring only the owner can read or write their settings.
- No sensitive data is stored — only a theme preference string.

---

## 7. Namespace

The protocol uses the namespace `urn:xmpp:fluux:appearance:0`. The `:0` suffix indicates an experimental version.
