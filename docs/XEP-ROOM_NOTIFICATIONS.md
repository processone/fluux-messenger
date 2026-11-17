# Proto-XEP: Per-Room Notification Level in Bookmarks

**Namespace:** `urn:xmpp:fluux:0`
**Dependencies:** XEP-0402 (PEP Native Bookmarks)
**Status:** Experimental (client-side implementation)

---

## 1. Introduction

This document describes how a client stores a per-room notification level inside the room's XEP-0402 bookmark, so that the choice is synchronized across the user's clients without any server-side module.

### 1.1 Motivation

Some rooms are busy and some are quiet, and a user wants to treat them differently: hear about every message in one room, only about mentions in most, and nothing at all in a noisy one. XEP-0402 stores the bookmark, and its `<extensions>` element is the place for client-specific data.

---

## 2. Requirements

- The server MUST support XEP-0402 (PEP Native Bookmarks).
- The client MUST keep the room's bookmark published for the setting to be saved. A room without a bookmark has no saved level.

---

## 3. Data Model

The level is a `<notify>` element in the `urn:xmpp:fluux:0` namespace, inside the `<extensions>` element of the bookmark's `<conference>` element:

```xml
<item id="room@conference.example.com">
  <conference xmlns="urn:xmpp:bookmarks:1" name="Room" autojoin="true">
    <nick>me</nick>
    <extensions>
      <notify xmlns="urn:xmpp:fluux:0">none</notify>
    </extensions>
  </conference>
</item>
```

### 3.1 Values

| Text of `<notify>` | Level              | Meaning                                                                     |
|--------------------|--------------------|-----------------------------------------------------------------------------|
| `all`              | All messages       | Notify for every message in the room.                                       |
| `none`             | Off                | Never notify for the room: no pop-up and no sound, mentions and replies included. The room does not add to the unread badge of the application icon. |
| *(element absent)* | Mentions only      | Notify for mentions and replies. This is the default.                       |

Mentions only is stored as no `<notify>` element at all. A client that publishes that level MUST NOT write `<notify>mentions</notify>`, but MUST accept it as Mentions only.

### 3.2 Unknown values

A client that finds a `<notify>` element with any other text (an empty element, or a value a later version defines) MUST read it as Mentions only. Values are case-sensitive.

### 3.3 Interaction with other extensions

A client that publishes a bookmark MUST carry the level the room already has unless the user is changing it. A bookmark publish replaces the stored item; omitting the element therefore resets the room to Mentions only. This applies to every publish: renaming the room, changing autojoin or the nickname, storing a password learned on join, and bookmarking a room on join.

---

## 4. Session choice

A client MAY let the user pick a level for the current session only. The session choice is never published, and it takes precedence over the saved level until the client leaves the room. The level that applies to a room is, in order: the session choice, the saved level, then Mentions only.

---

## 5. Older clients

Fluux versions that only know Mentions only and All messages read `none` as Mentions only. They do not preserve the element: when such a version re-publishes the bookmark (for example by editing the bookmark or toggling autojoin), the `none` value is erased and the room goes back to Mentions only on every client. A user who mixes client versions can therefore see an Off room return to Mentions only. Newer clients keep any level they read.

---

## 6. Namespace

The protocol uses the namespace `urn:xmpp:fluux:0`, shared with the other Fluux bookmark extensions. The `:0` suffix indicates an experimental version.

This document describes a Fluux-specific extension. A standardized per-room notification setting, XEP-0492 (Notification Settings), is experimental and not implemented by Fluux.
