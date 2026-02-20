# Supported XEPs

This document lists the XMPP Extension Protocols (XEPs) and related RFCs implemented in Fluux.

## IETF RFCs

| RFC                                                       | Name                | Status        | Notes                                                                                                                                               |
|-----------------------------------------------------------|---------------------|---------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| [RFC 6120](https://datatracker.ietf.org/doc/html/rfc6120) | XMPP Core           | ✅ Implemented | TCP binding with STARTTLS, direct TLS, SASL authentication, XML streams, stanzas. Web uses xmpp.js over WebSocket; desktop also supports native TCP |
| [RFC 6121](https://datatracker.ietf.org/doc/html/rfc6121) | XMPP IM             | ✅ Implemented | Instant messaging, presence, roster management                                                                                                      |
| [RFC 7622](https://datatracker.ietf.org/doc/html/rfc7622) | XMPP Address Format | ✅ Implemented | JID parsing and validation                                                                                                                          |
| [RFC 7395](https://datatracker.ietf.org/doc/html/rfc7395) | XMPP over WebSocket | ✅ Implemented | WebSocket transport for browser connectivity. Desktop Rust proxy bridges WebSocket (RFC 7395) framing to native TCP (RFC 6120) framing              |
| [RFC 5122](https://datatracker.ietf.org/doc/html/rfc5122) | XMPP URI Scheme     | ✅ Implemented | Deep linking support for `xmpp:` URIs - opens conversations and joins rooms from external links                                                     |
| [RFC 7590](https://datatracker.ietf.org/doc/html/rfc7590) | Use of TLS in XMPP  | ✅ Implemented | WSS for WebSocket connections, direct TLS and STARTTLS for native TCP connections (desktop), HTTPS for XEP-0156 discovery                           |

## Connection & Stream

| XEP                                                   | Name                                            | Status        | Notes                                                                                                       |
|-------------------------------------------------------|-------------------------------------------------|---------------|-------------------------------------------------------------------------------------------------------------|
| [XEP-0156](https://xmpp.org/extensions/xep-0156.html) | Discovering Alternative XMPP Connection Methods | ✅ Implemented | Auto-discovers WebSocket endpoint via host-meta (HTTPS-only for security)                                   |
| [XEP-0198](https://xmpp.org/extensions/xep-0198.html) | Stream Management                               | ✅ Implemented | Session resumption, message delivery reliability, ack tracking                                              |
| [XEP-0199](https://xmpp.org/extensions/xep-0199.html) | XMPP Ping                                       | ✅ Implemented | Responds to server/contact pings, uses ping for connection liveness checks                                  |
| [XEP-0280](https://xmpp.org/extensions/xep-0280.html) | Message Carbons                                 | ✅ Implemented | Sync messages across multiple connected clients                                                             |
| [XEP-0368](https://xmpp.org/extensions/xep-0368.html) | SRV Records for XMPP over TLS                   | ✅ Implemented | Desktop: SRV lookup for `_xmpps-client._tcp` (direct TLS) and `_xmpp-client._tcp` (STARTTLS) via Rust proxy |

## Service Discovery

| XEP                                                   | Name                  | Status        | Notes                                                                                                            |
|-------------------------------------------------------|-----------------------|---------------|------------------------------------------------------------------------------------------------------------------|
| [XEP-0030](https://xmpp.org/extensions/xep-0030.html) | Service Discovery     | ✅ Implemented | disco#info queries, server feature discovery on connect                                                          |
| [XEP-0059](https://xmpp.org/extensions/xep-0059.html) | Result Set Management | ✅ Implemented | Pagination for MAM queries                                                                                       |
| [XEP-0115](https://xmpp.org/extensions/xep-0115.html) | Entity Capabilities   | ✅ Implemented | Feature discovery, capability hash, PEP notifications, client identification from caps node with device tooltips |

## Account & Registration

| XEP                                                   | Name                 | Status        | Notes                             |
|-------------------------------------------------------|----------------------|---------------|-----------------------------------|
| [XEP-0077](https://xmpp.org/extensions/xep-0077.html) | In-Band Registration | ✅ Implemented | Password change from profile view |

## Roster & Presence

| XEP                                                   | Name                              | Status        | Notes                                                                             |
|-------------------------------------------------------|-----------------------------------|---------------|-----------------------------------------------------------------------------------|
| [XEP-0084](https://xmpp.org/extensions/xep-0084.html) | User Avatar                       | ✅ Implemented | PEP-based avatar display, publishing (256×256 JPEG with crop/resize), and removal |
| [XEP-0153](https://xmpp.org/extensions/xep-0153.html) | vCard-Based Avatars               | ✅ Implemented | Legacy avatar support with SHA-1 hash caching                                     |
| [XEP-0172](https://xmpp.org/extensions/xep-0172.html) | User Nickname                     | ✅ Implemented | Publish, retrieve, and clear own nickname via PEP                                 |
| [XEP-0191](https://xmpp.org/extensions/xep-0191.html) | Blocking Command                  | ✅ Implemented | Block/unblock JIDs, fetch blocklist, push notifications                           |
| [XEP-0319](https://xmpp.org/extensions/xep-0319.html) | Last User Interaction in Presence | ✅ Implemented | Idle time display and publishing                                                  |

## Messaging

| XEP                                                   | Name                         | Status        | Notes                                                                                                                      |
|-------------------------------------------------------|------------------------------|---------------|----------------------------------------------------------------------------------------------------------------------------|
| [XEP-0085](https://xmpp.org/extensions/xep-0085.html) | Chat State Notifications     | ✅ Implemented | Typing indicators for 1:1 and MUC (throttled for rooms < 30 occupants)                                                     |
| [XEP-0359](https://xmpp.org/extensions/xep-0359.html) | Unique and Stable Stanza IDs | ✅ Implemented | Message deduplication using stanza-id                                                                                      |
| [XEP-0393](https://xmpp.org/extensions/xep-0393.html) | Message Styling              | ✅ Implemented | Bold, italic, strikethrough, monospace, block quotes                                                                       |
| [XEP-0428](https://xmpp.org/extensions/xep-0428.html) | Fallback Indication          | ✅ Implemented | Used with message replies for client compatibility                                                                         |
| [XEP-0444](https://xmpp.org/extensions/xep-0444.html) | Message Reactions            | ✅ Implemented | Emoji reactions on messages in 1:1 and MUC                                                                                 |
| [XEP-0461](https://xmpp.org/extensions/xep-0461.html) | Message Replies              | ✅ Implemented | Reply-to with quoted preview and fallback body                                                                             |
| [XEP-0308](https://xmpp.org/extensions/xep-0308.html) | Last Message Correction      | ✅ Implemented | Edit last sent message with validation                                                                                     |
| [XEP-0424](https://xmpp.org/extensions/xep-0424.html) | Message Retraction           | ✅ Implemented | Delete own messages with sender verification                                                                               |
| [XEP-0363](https://xmpp.org/extensions/xep-0363.html) | HTTP File Upload             | ✅ Implemented | File upload with drag-and-drop, progress indicator, automatic service discovery                                            |
| [XEP-0066](https://xmpp.org/extensions/xep-0066.html) | Out of Band Data             | ✅ Implemented | File URL sharing with thumbnails                                                                                           |
| [XEP-0245](https://xmpp.org/extensions/xep-0245.html) | The /me Command              | ✅ Implemented | Action messages displayed in italic with sender name                                                                       |
| [XEP-0264](https://xmpp.org/extensions/xep-0264.html) | Jingle Content Thumbnails    | ✅ Implemented | Thumbnail element (`urn:xmpp:thumbs:1`) used with OOB file sharing — no Jingle dependency                                 |
| [XEP-0446](https://xmpp.org/extensions/xep-0446.html) | File Metadata Element        | ✅ Implemented | Original image/video dimensions for proper layout reservation                                                              |
| [XEP-0422](https://xmpp.org/extensions/xep-0422.html) | Message Fastening            | ✅ Implemented | Link previews with OGP metadata attached to messages                                                                       |
| [XEP-0203](https://xmpp.org/extensions/xep-0203.html) | Delayed Delivery             | ✅ Implemented | Offline message timestamps                                                                                                 |
| [XEP-0297](https://xmpp.org/extensions/xep-0297.html) | Stanza Forwarding            | ✅ Implemented | Used by Message Carbons                                                                                                    |
| [XEP-0313](https://xmpp.org/extensions/xep-0313.html) | Message Archive Management   | ✅ Implemented | History fetch for 1:1 chats and MUC rooms with scroll-up lazy loading, IndexedDB caching with MAM fallback, RSM pagination |
| [XEP-0334](https://xmpp.org/extensions/xep-0334.html) | Message Processing Hints     | ✅ Implemented | `<no-store/>` hint for transient messages (Quick Chat rooms), chat states and reactions                                    |

## PubSub & PEP

| XEP                                                   | Name                                          | Status        | Notes                                                                                                                |
|-------------------------------------------------------|-----------------------------------------------|---------------|----------------------------------------------------------------------------------------------------------------------|
| [XEP-0060](https://xmpp.org/extensions/xep-0060.html) | Publish-Subscribe                             | ✅ Implemented | PubSub event handling for avatars, nicknames, bookmarks, and settings                                                |
| [XEP-0163](https://xmpp.org/extensions/xep-0163.html) | Personal Eventing Protocol                    | ✅ Implemented | PEP notifications for avatars (XEP-0084), nicknames (XEP-0172), bookmarks (XEP-0402), appearance settings (XEP-0223) |
| [XEP-0223](https://xmpp.org/extensions/xep-0223.html) | Persistent Storage of Private Data via PubSub | ✅ Implemented | Theme/appearance settings sync across devices                                                                        |

## Multi-User Chat (MUC)

| XEP                                                   | Name                        | Status        | Notes                                                                                                       |
|-------------------------------------------------------|-----------------------------|---------------|-------------------------------------------------------------------------------------------------------------|
| [XEP-0045](https://xmpp.org/extensions/xep-0045.html) | Multi-User Chat             | ✅ Implemented | Join/leave rooms, messaging, occupant list with presence tooltips, roles/affiliations, mediated invitations |
| [XEP-0054](https://xmpp.org/extensions/xep-0054.html) | vCard-temp                  | ✅ Implemented | Room avatar retrieval and display                                                                           |
| [XEP-0317](https://xmpp.org/extensions/xep-0317.html) | Hats                        | ✅ Implemented | Custom role tags displayed as colored badges in occupant panel and messages                                 |
| [XEP-0392](https://xmpp.org/extensions/xep-0392.html) | Consistent Color Generation | ✅ Implemented | Deterministic colors for avatars, nicknames, and hat badges based on identifier                             |
| [XEP-0249](https://xmpp.org/extensions/xep-0249.html) | Direct MUC Invitations      | ✅ Implemented | Receive room invitations with Accept/Decline in Events view                                                 |
| [XEP-0372](https://xmpp.org/extensions/xep-0372.html) | References                  | ✅ Implemented | @mention notifications with position-based highlighting                                                     |
| [XEP-0402](https://xmpp.org/extensions/xep-0402.html) | PEP Native Bookmarks        | ✅ Implemented | Room bookmarks with autojoin, custom extensions for notification preferences                                |

## Administration

| XEP                                                   | Name                   | Status        | Notes                                                        |
|-------------------------------------------------------|------------------------|---------------|--------------------------------------------------------------|
| [XEP-0004](https://xmpp.org/extensions/xep-0004.html) | Data Forms             | ✅ Implemented | Dynamic form rendering for admin commands                    |
| [XEP-0050](https://xmpp.org/extensions/xep-0050.html) | Ad-Hoc Commands        | ✅ Implemented | Command execution with multi-step flows                      |
| [XEP-0133](https://xmpp.org/extensions/xep-0133.html) | Service Administration | ✅ Implemented | Admin panel for user management, server stats, announcements |

## Project Information

| XEP                                                   | Name               | Status        | Notes                                                                             |
|-------------------------------------------------------|--------------------|---------------|-----------------------------------------------------------------------------------|
| [XEP-0453](https://xmpp.org/extensions/xep-0453.html) | DOAP Usage in XMPP | ✅ Implemented | Machine-readable project description with supported XEPs (`fluux-messenger.doap`) |

## Planned XEPs

The following XEPs are planned for future implementation:

| XEP                                                   | Name                      | Category  |
|-------------------------------------------------------|---------------------------|-----------|
| [XEP-0184](https://xmpp.org/extensions/xep-0184.html) | Message Delivery Receipts | Messaging |
| [XEP-0333](https://xmpp.org/extensions/xep-0333.html) | Chat Markers              | Messaging |
| [XEP-0384](https://xmpp.org/extensions/xep-0384.html) | OMEMO Encryption          | Security  |

## Custom Extensions

Fluux also uses custom extensions in the `urn:xmpp:fluux:0` namespace:

- **Room notification preferences**: Stored in XEP-0402 bookmark extensions to enable per-room notification settings (mentions only vs. all messages)
- **@all mentions**: Room-wide mention indicator for notifying all participants
- **Quick chat marker**: `<quickchat xmlns="urn:xmpp:fluux:0"/>` element included in MUC invitations to indicate the room is a temporary quick chat (non-persistent, auto-destroys when empty)
