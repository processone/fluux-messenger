# Push notification payload

**Status:** Client contract. `encrypted` is read by the iOS notification extension; the
gateway and XMPP server must supply it.
**Gateways:** `push.fluux.io` (production), `pushdev.fluux.io` (development).

The XMPP server publishes a XEP-0357 notification to the gateway, which sends one APNs
alert to the device. This document lists the APNs fields the Fluux notification extension
reads and what it does with each. For registration and deletion, see the
[gateway unregistration contract](PUSH_GATEWAY_UNREGISTER.md).

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `aps.alert` | string | The message body, or a generic text when the server sends none. |
| `aps.mutable-content` | `1` | Required: the notification extension only runs with it. |
| `aps.sound`, `aps.content-available` | | Passed through. |
| `aps.thread-id` | string | Optional. Notification Center grouping, kept as sent. It names the conversation: one value per contact or room, never including the occupant's nick. When absent, the extension uses the bare JID of `from`. |
| `from` | string | The sender: the contact's JID, or the occupant JID `room@service/nick` for a group chat. The extension shows the room name as title and the nick as subtitle. |
| `to` | string | Optional. The account the push is for; a mismatch shows a neutral alert. |
| `encrypted` | boolean | Optional. `false`: `aps.alert` is the message's own body. `true`: the message is encrypted and `aps.alert` is not its content. |

`from` must identify the message's sender. A value without a local part, such as the server's
domain when the XMPP server withholds the sender, cannot be matched to a contact or a room and
is shown as is.

ejabberd Business Edition builds `thread-id` from the sender: the local part for a contact on the
account's own domain, `room@conf` for a room on `conference.<domain>`, and the bare JID otherwise.
These values cannot collide, since a local part contains no `@`.

## The `encrypted` field

Only the XMPP server sees the stanza, so only it can tell a message's own body from a
fallback. A message is encrypted when it carries any of:

- `<openpgp xmlns='urn:xmpp:openpgp:0'>` (XEP-0373),
- `<encrypted xmlns='eu.siacs.conversations.axolotl'>` or `<encrypted xmlns='urn:xmpp:omemo:2'>` (XEP-0384),
- `<x xmlns='jabber:x:encrypted'>` (XEP-0027),
- `<encryption xmlns='urn:xmpp:eme:0'>` (XEP-0380).

For an encrypted message the server should omit the body from the summary, and the gateway
should send `encrypted: true` with a generic `aps.alert`. For any other message with a body,
it should send the body and `encrypted: false`.

On iOS, `encrypted: false` makes the extension show `aps.alert` without fetching the
archive. Without the field, an opted-in OpenPGP preview fetches the sender's recent archive;
see [OpenPGP notification previews](IOS_DEVELOPMENT.md#openpgp-notification-previews).

The XEP-0357 summary form has no standard field for this. The XMPP server has to add one
(for example `encrypted` in the `urn:xmpp:push:summary` form) and the gateway has to map it.
