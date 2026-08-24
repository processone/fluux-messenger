# Fluux Messenger Marketing Page Draft

> This is a draft for the ProcessOne website Fluux page.
> Screenshot placeholders reference the demo mode (`npm run dev` → `/demo.html`).
> Real URLs are taken from the current live page at process-one.net/fluux/.

---

## Hero

**Fluux Messenger**

*The modern XMPP client for teams who own their data.*

A cross-platform messenger built on open standards. Connect to any XMPP server, self-hosted or public. Your messages, your infrastructure, no vendor lock-in.

Available for **Windows**, **macOS**, **Linux**, and **Web**.

[Download](https://github.com/processone/fluux-messenger/releases/latest) · [View on GitHub](https://github.com/processone/fluux-messenger)

> **Screenshot**: Full app with Emma's conversation open. Shows the sidebar with conversations, avatars, presence indicators, and the chat view with messages, reactions, and an image attachment.

---

## Why Fluux Messenger?

### Sovereign by Design

Connect to any XMPP server. Self-host with ejabberd or use any public provider. Your messages stay on your infrastructure: no third-party cloud, no data mining.

### Fast & Lightweight

Built with Tauri and React for native desktop performance without the Electron overhead. Local message caching means instant access to your conversations, even offline.

### Everything You Expect From a Messenger

Emoji reactions, message replies, typing indicators, file sharing, link previews, group chats, all built on XMPP standards.

### Cross-Platform

One client for all your devices. Native desktop apps for Windows, macOS, and Linux. Web version for anywhere else. The same interface everywhere.

### Speaks Your Language

34 languages, including English, French, German, Spanish, Italian, Portuguese, Chinese, Korean, and every official EU language.

### Reliable Connections

Stream Management (XEP-0198) resends what the network dropped, so messages survive an unstable connection. Sessions resume after a reconnect without re-downloading history, and the message archive syncs across all your devices.

---

## Features in Action

### One-on-One Chats

Emoji reactions, threaded replies with quoted context, and typing indicators. Messages sync across all your connected clients.

> **Screenshot**: Emma's conversation. Shows reactions (fire, rocket, thumbs up), a reply with a quoted message, and the image attachment.

### Group Chat for Teams

Multi-user chat rooms with @mentions, emoji reactions, and message replies. See who's online, who's away, and who's in do-not-disturb. Bookmark your important rooms for quick access.

> **Screenshot**: Team Chat room. Shows multiple participants, reactions with multiple users, a reply quoting another message, and the occupant list.

### File Sharing

Share images, documents, and videos directly in the conversation. Inline previews for images and videos. Any file type works, via HTTP File Upload.

> **Screenshot**: Sophia's conversation. Shows the PDF attachment, the video attachment with preview, and the inline image from Emma's conversation.

### Link Previews

Shared URLs get a title, description, and preview image, so you can see where a link goes without opening it.

> **Screenshot**: James's conversation. Shows the ProcessOne blog link with the Open Graph preview card.

### Contact Management

Each contact shows a presence indicator, a status message, and their connected devices. Organize contacts by group. Contact cards show availability across multiple clients.

> **Screenshot**: Contacts view (the Fluux contacts screenshot already captured).

### Server Admin Interface

Manage your ejabberd server from the client: monitor connected users, manage rooms, and run administrative commands without switching to a separate tool.

### XMPP Console

Built-in protocol console for developers and admins. Inspect raw XMPP stanzas in real time and see exactly which packets go in and out.

### Dark and Light Themes

The interface follows your system setting, or you can pick a theme yourself. There are 14 built in, plus a custom accent color if none of them fit.

> **Screenshot**: Side-by-side of dark and light themes (take two screenshots from demo).

---

## Built for Reliability

| Feature                          | What it means                                                   |
|----------------------------------|-----------------------------------------------------------------|
| **Stream Management** (XEP-0198) | Messages survive a dropped connection on flaky Wi-Fi or mobile  |
| **Session Resumption**           | Reconnects without re-downloading your history                  |
| **Message Archive** (MAM)        | Full conversation history synced across all your devices        |
| **Message Carbons** (XEP-0280)   | Send a message from desktop, see it on your phone               |
| **Local Cache**                  | Instant access to recent messages, even offline                 |

---

## Works With Any XMPP Server

Fluux Messenger connects to any standard XMPP server over WebSocket. It works especially well with **ejabberd**, the server behind WhatsApp-scale deployments.

| Client                     | Server                         |
|----------------------------|--------------------------------|
| **Fluux Messenger**        | **ejabberd**                   |
| Modern UI & UX             | 2M+ connections per node       |
| Desktop, Web               | XMPP, MQTT, SIP                |
| TypeScript / React / Tauri | 25 years of proven reliability |

Together they make a **European sovereign messaging stack**.

[Learn more about ejabberd →](https://www.process-one.net/ejabberd/)

---

## 50+ XMPP Extensions

Fluux Messenger implements these XMPP extensions (XEPs), among others:

- **XEP-0198** Stream Management: message reliability and session resumption
- **XEP-0280** Message Carbons: sync across multiple clients
- **XEP-0313** Message Archive Management: full history sync
- **XEP-0363** HTTP File Upload: share files of any size
- **XEP-0444** Message Reactions: emoji reactions on messages
- **XEP-0461** Message Replies: threaded replies with quoted context
- **XEP-0422** Message Fastening: link previews and metadata
- **XEP-0085** Chat State Notifications: typing indicators
- **XEP-0308** Message Correction: edit sent messages
- **XEP-0045** Multi-User Chat: group conversations
- And many more...

---

## Technical Specs

|                |                                                   |
|----------------|---------------------------------------------------|
| **Platforms**  | Windows, macOS, Linux, Web                        |
| **Built with** | TypeScript, React, Tauri                          |
| **License**    | AGPL-3.0 (Open Source) or commercial license      |
| **Protocol**   | XMPP over WebSocket                               |
| **Languages**  | 34 supported (EN, FR, DE, ES, IT, PT, ZH, KO…)    |
| **Storage**    | IndexedDB with automatic sync                     |
| **Server**     | Any XMPP server with or without WebSocket support |

---

## Open Source

Fluux Messenger is released under AGPL-3.0 or commercial license. Privacy-respecting messaging shouldn't require vendor lock-in.

Inspect the code, contribute, or fork it.

[GitHub Repository](https://github.com/processone/fluux-messenger) · [Read the announcement →](https://www.process-one.net/blog/introducing-fluux-messenger-a-modern-xmpp-client-born-from-a-holiday-coding-session/)

---

## For Developers: The Fluux SDK

Fluux Messenger is built on **@fluux/sdk**, a headless, reusable XMPP SDK for TypeScript. Use it to build your own XMPP clients, bots, or integrations:

- Clean React hooks API or direct Zustand store access
- All protocol logic encapsulated, so no XMPP knowledge is required
- Event-driven architecture with typed SDK events
- Works with or without React

```typescript
import { XMPPClient } from '@fluux/sdk'

const client = new XMPPClient()
client.connect({ jid: 'user@example.com', password: '...' })
client.on('online', () => {
  client.chat.sendMessage('friend@example.com', 'Hello!')
})
```

[SDK Documentation]

---

## Get Started

- **Download**: [Windows, macOS, Linux from GitHub Releases](https://github.com/processone/fluux-messenger/releases/latest)
- **Web**: Use directly in your browser, no installation needed
- **Community**: Join us on XMPP: `fluux-messenger@conference.process-one.net`
- **Contribute**: [GitHub Repository](https://github.com/processone/fluux-messenger) / [Report Issues](https://github.com/processone/fluux-messenger/issues)

---

## Commercial Licensing

Contact us for a commercial license and customization of Fluux Messenger for your organization.

**Fluux Messenger + ejabberd Business Edition** = complete sovereign messaging with SLA.

[Contact us →](https://www.process-one.net/contact/)
