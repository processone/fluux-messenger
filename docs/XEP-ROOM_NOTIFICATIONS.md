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
| `none`             | Off                | A running client never notifies for the room: no pop-up and no sound, mentions and replies included. The room does not add to the unread badge of the application icon. See 3.4 for pushes received while the client is closed. |
| *(element absent)* | Mentions only      | Notify for mentions and replies. This is the default.                       |

Mentions only is stored as no `<notify>` element at all. A client that publishes that level MUST NOT write `<notify>mentions</notify>`, but MUST accept it as Mentions only.

### 3.2 Unknown values

A client that finds a `<notify>` element with any other text (an empty element, or a value a later version defines) MUST read it as Mentions only. Values are case-sensitive.

### 3.3 Interaction with other extensions

A client that publishes a bookmark MUST carry the level the room already has unless the user is changing it. A bookmark publish replaces the stored item; omitting the element therefore resets the room to Mentions only. This applies to every publish: renaming the room, changing autojoin or the nickname, storing a password learned on join, and bookmarking a room on join.

The same publish MUST keep every other child of `<extensions>` unchanged, as XEP-0402 requires for elements a client does not understand. Fluux writes only its own `<notify>` element and publishes the other children exactly as it last read them, with the namespace declarations they inherited, so another client's settings for the room, such as XEP-0492 notification settings, survive a change made in Fluux. Fluux publishes from its own copy of the bookmark only when the current connection has confirmed it: the bookmark list read on that connection returned the room, or Fluux saved the room on it. Otherwise, for example after a page reload or a reconnection, while that read has not answered, after it failed, or for a room not bookmarked yet, Fluux reads the room's stored bookmark first and carries over its password, notification level and other extensions, and its name, nickname and autojoin wherever the user left them as Fluux showed them, so a rename, or a nickname set or removed in another client, is not undone. If that read fails, Fluux publishes nothing. Fluux makes the saves and removals of one room's bookmark one after another, in the order the user made them, so a save never starts from the bookmark as it was before the previous one. A save or removal still waiting when the connection changes or another account signs in is dropped without sending anything, and a level saved after a removal that came first applies as a session choice (section 4). Fluux writes a level the user saves into its copy of the bookmark only once the server has stored it, and applies it as a session choice until then. The room header cannot tell such a level from a session choice, so on a bookmarked room that shows All messages or Off, choosing Mentions only, or All messages for the session, also saves Mentions only, and the bookmark ends on the user's latest choice. When the bookmark stores Mentions only, Mentions only applies at once for the session, so it stays applied if that save is refused. If the server refuses the publish, the room returns to the choice it had before, and later publishes carry the level the bookmark still stores. A copy restored from local storage, or rebuilt from events the server delivers again when a stream resumes, can be older than the stored bookmark, and publishing it would bring back settings changed elsewhere.

---

## 4. Session choice

A client MAY let the user pick a level for the current session only. The session choice is never published, and it takes precedence over the saved level until the client leaves the room. The level that applies to a room is, in order: the session choice, the saved level, then Mentions only.

---

### 3.4 Closed-app push

`none` is honored by a client that is running. Push notifications delivered while the client is closed (the iOS notification extension and the web push service worker in Fluux) are shown by the platform without reading the bookmark, so they are not silenced yet. Fluux cannot stop the server from sending them; making them arrive silently and uncounted is planned separately.

---

## 5. Older clients

Fluux versions that only know Mentions only and All messages read `none` as Mentions only. They do not preserve the element: when such a version re-publishes the bookmark (for example by editing the bookmark or toggling autojoin), the `none` value is erased and the room goes back to Mentions only on every client. A user who mixes client versions can therefore see an Off room return to Mentions only. Newer clients keep any level they read.

---

## 6. Namespace

The protocol uses the namespace `urn:xmpp:fluux:0`, shared with the other Fluux bookmark extensions. The `:0` suffix indicates an experimental version.

This document describes a Fluux-specific extension. A standardized per-room notification setting, XEP-0492 (Notification Settings), is experimental and not implemented by Fluux.
