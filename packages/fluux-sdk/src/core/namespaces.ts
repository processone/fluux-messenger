/**
 * XMPP Namespace Constants
 *
 * Centralized namespace definitions for all supported XEPs.
 * These are used throughout the SDK for XML parsing and generation.
 */

// XEP-0030: Service Discovery
export const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info'
export const NS_DISCO_ITEMS = 'http://jabber.org/protocol/disco#items'

// XEP-0363: HTTP File Upload
export const NS_HTTP_UPLOAD = 'urn:xmpp:http:upload:0'

// XEP-0066: Out of Band Data
export const NS_OOB = 'jabber:x:oob'

// XEP-0264: Jingle Content Thumbnails
export const NS_THUMBS = 'urn:xmpp:thumbs:1'

// XEP-0446: File Metadata Element
export const NS_FILE_METADATA = 'urn:xmpp:file:metadata:0'

// XEP-0085: Chat State Notifications
export const NS_CHATSTATES = 'http://jabber.org/protocol/chatstates'

// XEP-0115: Entity Capabilities
export const NS_CAPS = 'http://jabber.org/protocol/caps'

// XEP-0054: vcard-temp
export const NS_VCARD_TEMP = 'vcard-temp'

// XEP-0153: vCard-Based Avatars
export const NS_VCARD_UPDATE = 'vcard-temp:x:update'

// XEP-0280: Message Carbons
export const NS_CARBONS = 'urn:xmpp:carbons:2'

// XEP-0297: Stanza Forwarding
export const NS_FORWARD = 'urn:xmpp:forward:0'

// XEP-0393: Message Styling
export const NS_STYLING = 'urn:xmpp:styling:0'

// XEP-0428: Fallback Indication
// Standard namespace is urn:xmpp:fallback:0, but some clients use the older draft namespace
export const NS_FALLBACK = 'urn:xmpp:fallback:0'
export const NS_FALLBACK_LEGACY = 'urn:xmpp:feature-fallback:0'

// XEP-0444: Message Reactions
export const NS_REACTIONS = 'urn:xmpp:reactions:0'

// XEP-0461: Message Replies
export const NS_REPLY = 'urn:xmpp:reply:0'

// XEP-0308: Last Message Correction
export const NS_CORRECTION = 'urn:xmpp:message-correct:0'

// XEP-0424: Message Retraction
export const NS_RETRACT = 'urn:xmpp:message-retract:1'

// XEP-0319: Last User Interaction in Presence
export const NS_IDLE = 'urn:xmpp:idle:1'

// PubSub namespaces
export const NS_PUBSUB = 'http://jabber.org/protocol/pubsub'
export const NS_PUBSUB_EVENT = 'http://jabber.org/protocol/pubsub#event'

// XEP-0084: User Avatar (PEP)
export const NS_AVATAR_DATA = 'urn:xmpp:avatar:data'
export const NS_AVATAR_METADATA = 'urn:xmpp:avatar:metadata'
export const NS_AVATAR_METADATA_NOTIFY = 'urn:xmpp:avatar:metadata+notify'

// XEP-0172: User Nickname
export const NS_NICK = 'http://jabber.org/protocol/nick'

// XEP-0045: Multi-User Chat (MUC)
export const NS_MUC = 'http://jabber.org/protocol/muc'
export const NS_MUC_USER = 'http://jabber.org/protocol/muc#user'
export const NS_MUC_OWNER = 'http://jabber.org/protocol/muc#owner'

// XEP-0249: Direct MUC Invitations
export const NS_CONFERENCE = 'jabber:x:conference'

// XEP-0402: PEP Native Bookmarks
export const NS_BOOKMARKS = 'urn:xmpp:bookmarks:1'
export const NS_BOOKMARKS_NOTIFY = 'urn:xmpp:bookmarks:1+notify'

// XEP-0203: Delayed Delivery
export const NS_DELAY = 'urn:xmpp:delay'

// XEP-0359: Unique and Stable Stanza IDs
export const NS_STANZA_ID = 'urn:xmpp:sid:0'

// XEP-0372: References
export const NS_REFERENCE = 'urn:xmpp:reference:0'

// Custom: Mention All (room-wide mentions)
export const NS_MENTION_ALL = 'urn:fluux:mentions:0'

// Custom: Fluux extensions (for bookmark extensions, etc.)
export const NS_FLUUX = 'urn:xmpp:fluux:0'

// Custom: Fluux appearance settings (XEP-0223 private storage)
export const NS_APPEARANCE = 'urn:xmpp:fluux:appearance:0'

// XEP-0334: Message Processing Hints
export const NS_HINTS = 'urn:xmpp:hints'

// XEP-0422: Message Fastening
export const NS_FASTEN = 'urn:xmpp:fasten:0'

// XHTML namespace (for OGP meta elements in link previews)
export const NS_XHTML = 'http://www.w3.org/1999/xhtml'

// Custom: Easter Egg animations
export const NS_EASTER_EGG = 'urn:fluux:easter-egg:0'

// XEP-0050: Ad-Hoc Commands
export const NS_COMMANDS = 'http://jabber.org/protocol/commands'

// XEP-0133: Service Administration
export const NS_ADMIN = 'http://jabber.org/protocol/admin'

// XEP-0004: Data Forms
export const NS_DATA_FORMS = 'jabber:x:data'

// XEP-0059: Result Set Management
export const NS_RSM = 'http://jabber.org/protocol/rsm'

// XEP-0313: Message Archive Management
export const NS_MAM = 'urn:xmpp:mam:2'

// XEP-0077: In-Band Registration
export const NS_REGISTER = 'jabber:iq:register'

// XEP-0317: Hats
export const NS_HATS = 'urn:xmpp:hats:0'

// XEP-0199: XMPP Ping
export const NS_PING = 'urn:xmpp:ping'

// XEP-0191: Blocking Command
export const NS_BLOCKING = 'urn:xmpp:blocking'

// RFC 6120: XMPP Stanza Error Conditions
export const NS_XMPP_STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas'

// p1:push - ejabberd Business Edition Push Notifications
export const NS_P1_PUSH = 'p1:push'
export const NS_P1_PUSH_WEBPUSH = 'p1:push:webpush'
