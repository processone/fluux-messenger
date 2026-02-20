# @fluux/sdk

A headless SDK for building XMPP chat applications. The core is framework-agnostic, with React bindings provided out of the box.

## Design principles

My approach is to apply reactive application design pattern to Fluux Messenger, using a reactive layered architecture (three tiered).

```
┌─────────────┐      state      ┌─────────────┐     events      ┌─────────────┐
│     UI      │ ←─────────────→ │     SDK     │ ←─────────────→ │ XMPP Server │
│ (Reactive)  │    commands     │   (State    │    stanzas      │             │
│             │                 │   Container)│                 │             │
└─────────────┘                 └─────────────┘                 └─────────────┘
```

The SDK acts as a state container and protocol abstraction layer, exposing the application state to the UI through reactive subscriptions and accepting commands through a clean API.

In other words, the SDK handles XMPP protocol translation, transforming user commands into state change commands (that may or may not require sending stanzas) and server events into state updates. If I manage to make this rights, the UI should be a pure function of this state, never speaking XMPP directly.

This is not a utopia. Most GUI applications are designed with such architectural patterns (some use MVC, MVVM, reactive design, etc).

Fluux SDK push the cursor to the maximum to decouple as much as possible UI from XMPP and the SDK is a tool for that.

## Headless Client Design

The SDK is designed as a **headless XMPP client**. This means it handles all XMPP protocol complexity internally, exposing only a clean, simple API to your application.

### Signal Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Application                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   User Action ──────► SDK Hook ──────► XMPP Protocol            │
│   (click send)        (sendMessage)    (stanza sent)            │
│                                                                  │
│   UI Update ◄──────── Store Update ◄── XMPP Event               │
│   (new message)       (addMessage)     (message received)       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Inbound (App → SDK → XMPP Server)**:
- Your app calls SDK actions based on user interactions (e.g., `sendMessage()`, `joinRoom()`)
- The SDK translates these into XMPP protocol operations
- Your app never constructs XMPP stanzas directly

**Outbound (XMPP Server → SDK → App)**:
- The SDK receives XMPP events and updates Zustand stores atomically
- Your app subscribes to store changes via hooks and re-renders automatically
- Your app never parses XMPP stanzas directly

### What This Means for Your App

| Your App Does | SDK Handles |
|---------------|-------------|
| Call `sendMessage(to, body)` | Build message stanza, handle carbons, store sent message |
| Call `connect(options)` | WebSocket discovery, authentication, session resumption |
| Read `messages` from store | MAM queries, caching, deduplication, sorting |
| Read `contacts` from store | Roster management, presence aggregation, avatar loading |

### Automatic Background Operations

The SDK performs many operations automatically without app intervention:

- **Cache loading**: Messages load from IndexedDB instantly when switching conversations
- **Lazy MAM**: New messages are fetched from the server only when opening a conversation (not on connect)
- **Scroll pagination**: Older messages load via MAM when scrolling up through history
- **Reconnect catch-up**: After reconnect, only the active conversation fetches missed messages
- **Presence**: Contact presence updates flow into the store automatically
- **Reconnection**: Exponential backoff reconnection with session resumption
- **Stream Management**: Message reliability via XEP-0198

Your app just renders what's in the stores—no orchestration needed.

### Lazy Loading Architecture

The SDK uses **lazy loading** for message archives to optimize connection time and bandwidth:

```
┌─────────────────────────────────────────────────────────────────┐
│                    On Connect                                   │
│   - Load roster, bookmarks, presence (fast)                     │
│   - NO MAM queries (deferred to conversation open)              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                 On Conversation Open                            │
│   1. Load from IndexedDB cache (instant)                        │
│   2. Background MAM query for newer messages (if connected)     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                  On Scroll Up                                   │
│   - fetchOlderHistory() queries MAM for older messages          │
│   - Caches results in IndexedDB for next time                   │
└─────────────────────────────────────────────────────────────────┘
```

This means conversations you don't open don't consume bandwidth or memory.

## Architecture

The SDK is designed with a layered architecture:

- **Core** (`src/core/`) - Framework-agnostic XMPP client, handlers, and types
- **Stores** (`src/stores/`) - Zustand stores (can be used with any framework)
- **Hooks** (`src/hooks/`) - React hooks (convenience wrappers)
- **Provider** (`src/provider/`) - React context provider

> **Future Framework Support**: The core and stores are framework-agnostic and could be wrapped
> with Vue composables or Svelte stores. Plans for `@fluux/sdk-vue` and `@fluux/sdk-svelte`.

## Bundle Structure

The SDK is split into focused bundles for optimal tree-shaking:

| Bundle | Import Path | Description | Use Case |
|--------|-------------|-------------|----------|
| **Full** | `@fluux/sdk` | Complete SDK with React | React apps (default) |
| **React** | `@fluux/sdk/react` | Provider + hooks only | Smaller React bundle |
| **Core** | `@fluux/sdk/core` | XMPPClient + types | Bots, CLI, other frameworks |
| **Stores** | `@fluux/sdk/stores` | Direct Zustand stores | Advanced state access |

### React Apps

```tsx
// Option 1: Full bundle (includes everything)
import { XMPPProvider, useConnection, useChat } from '@fluux/sdk'

// Option 2: Separate imports (smaller bundles, same API)
import { XMPPProvider, useConnection, useChat } from '@fluux/sdk/react'
import { getBareJid, generateConsistentColorHex } from '@fluux/sdk'
```

### Headless Usage (Bots, CLI, Non-React)

```typescript
import { XMPPClient, createDefaultStoreBindings } from '@fluux/sdk/core'
import { useConnectionStore, useChatStore } from '@fluux/sdk/stores'

// Create client and connect
const client = new XMPPClient()
await client.connect({
  jid: 'bot@example.com',
  password: 'secret',
  server: 'example.com'
})

// Use client API
client.chat.sendMessage('user@example.com', 'Hello from bot!')

// Or access stores directly
const status = useConnectionStore.getState().status
const conversations = useChatStore.getState().conversations
```

## Installation

```bash
npm install @fluux/sdk react zustand xstate @xstate/react
```

The SDK requires the following peer dependencies:

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ≥18.0.0 | React hooks and provider |
| `zustand` | ≥4.0.0 | State management |
| `xstate` | ≥5.0.0 | Presence state machine |
| `@xstate/react` | ≥6.0.0 | React bindings for XState |

## Quick Start

```tsx
import { XMPPProvider, useConnection, useChat, useRoster } from '@fluux/sdk'

// Wrap your app with the provider
function App() {
  return (
    <XMPPProvider debug={true}>
      <MyChat />
    </XMPPProvider>
  )
}

// Use hooks in components
function MyChat() {
  const { status, connect, disconnect } = useConnection()
  const { conversations, activeMessages, sendMessage } = useChat()
  const { contacts } = useRoster()

  // ... your UI
}
```

## Hooks API

### `useConnection()`

```typescript
const {
  status,           // 'disconnected' | 'connecting' | 'online' | 'reconnecting' | 'error'
  jid,              // Current JID or null
  error,            // Error message or null
  reconnectAttempt, // Current reconnect attempt number
  reconnectIn,      // Seconds until next reconnect
  presenceShow,     // Current presence: 'online' | 'away' | 'dnd' | 'offline'
  statusMessage,    // Custom status message or null
  connect,          // (options: ConnectOptions) => Promise<void>
  disconnect,       // () => Promise<void>
  cancelReconnect,  // () => void
  setPresence,      // (show?, status?) => Promise<void>
} = useConnection()
```

### `useChat()`

Manages 1:1 chat conversations. **Auto-fetches** messages from cache and MAM when a conversation becomes active—your app just renders what's in the store.

```typescript
const {
  // State
  conversations,          // Conversation[] - Active conversations sorted by last activity
  archivedConversations,  // Conversation[] - Archived conversations
  activeConversationId,   // string | null - Active conversation ID
  activeConversation,     // Conversation | null - Active conversation object
  activeMessages,         // Message[] - Messages in active conversation
  activeTypingUsers,      // string[] - JIDs currently typing
  drafts,                 // Map<string, string> - Draft messages per conversation
  supportsMAM,            // boolean - Whether server supports message archive
  activeMAMState,         // MAMQueryState | null - Archive query state

  // Actions
  sendMessage,            // (to, body, type?, replyTo?, attachment?) => Promise<string>
  setActiveConversation,  // (id: string | null) => void
  markAsRead,             // (conversationId: string) => void
  archiveConversation,    // (id: string) => void
  unarchiveConversation,  // (id: string) => void
  sendChatState,          // (to, state: 'composing' | 'paused', type?) => Promise<void>
  sendReaction,           // (to, messageId, emojis: string[]) => Promise<void>
  sendCorrection,         // (conversationId, messageId, newBody, attachment?) => Promise<void>
  retractMessage,         // (conversationId, messageId) => Promise<void>
  setDraft,               // (conversationId, text) => void
  getDraft,               // (conversationId) => string | undefined
  clearDraft,             // (conversationId) => void
  fetchOlderHistory,      // (conversationId?) => Promise<void> - Scroll-up pagination
} = useChat()
```

### `useRoster()`

```typescript
const {
  contacts,        // Contact[]
  sortedContacts,  // Contacts sorted by presence then name
  onlineContacts,  // Online contacts only
  removeContact,   // (jid: string) => Promise<void>
} = useRoster()
```

### `useConsole()`

```typescript
const {
  entries,       // XmppPacket[] - All packets and events
  isOpen,        // Console panel visibility
  toggle,        // () => void
  clearEntries,  // () => void
} = useConsole()
```

### `useEvents()`

```typescript
const {
  subscriptionRequests,  // SubscriptionRequest[] - Pending subscription requests
  strangerMessages,      // StrangerMessage[] - Messages from non-roster JIDs
  strangerConversations, // Record<string, StrangerMessage[]> - Grouped by sender
  mucInvitations,        // MucInvitation[] - Pending room invitations
  pendingCount,          // Number of pending events
  acceptSubscription,    // (jid: string) => Promise<void>
  rejectSubscription,    // (jid: string) => Promise<void>
  acceptStranger,        // (jid: string) => Promise<void> - Add to roster and move messages
  ignoreStranger,        // (jid: string) => void - Remove stranger messages
  acceptInvitation,      // (invitation: MucInvitation) => Promise<void>
  declineInvitation,     // (invitation: MucInvitation) => void
} = useEvents()
```

### `useAdmin()`

```typescript
const {
  isAdmin,           // boolean - Whether current user has admin privileges
  commands,          // AdminCommand[] - Available admin commands
  categories,        // AdminCategory[] - Command categories
  executeCommand,    // (node: string, payload?: Record<string, string>) => Promise<DataForm | null>
  discoverCommands,  // () => Promise<void>
} = useAdmin()
```

### `useBlocking()`

```typescript
const {
  blocklist,      // string[] - List of blocked JIDs
  isBlocked,      // (jid: string) => boolean
  block,          // (jid: string) => Promise<void>
  unblock,        // (jid: string) => Promise<void>
  unblockAll,     // () => Promise<void>
  fetchBlocklist, // () => Promise<void>
} = useBlocking()
```

### `usePresence()`

```typescript
const {
  show,              // 'online' | 'away' | 'dnd' | 'xa' - Current presence show
  statusMessage,     // string | null - Custom status message
  setPresence,       // (show: UserPresenceShow, status?: string) => void
  setStatusMessage,  // (status: string | null) => void
  goOnline,          // () => void
  goAway,            // () => void
  goDnd,             // () => void
  goOffline,         // () => void
} = usePresence()
```

### `useRoom()`

Manages Multi-User Chat (MUC) rooms. **Auto-loads** messages from cache when a room becomes active—your app just renders what's in the store. Room history comes from the join process; older messages load via `fetchOlderHistory()` on scroll.

```typescript
const {
  // State
  joinedRooms,              // Room[] - Currently joined rooms
  bookmarkedRooms,          // Room[] - Bookmarked rooms
  allRooms,                 // Room[] - All rooms (joined or bookmarked)
  quickChatRooms,           // Room[] - Temporary/quick chat rooms
  activeRoomJid,            // string | null - Active room JID
  activeRoom,               // Room | undefined - Active room object
  activeMessages,           // RoomMessage[] - Messages in active room
  activeTypingUsers,        // string[] - Nicknames currently typing
  totalMentionsCount,       // number - Total @mentions across all rooms
  totalUnreadCount,         // number - Total unread messages
  drafts,                   // Map<string, string> - Draft messages per room
  activeMAMState,           // MAMQueryState | null - Archive query state

  // Actions
  joinRoom,                 // (jid, nickname, options?) => Promise<void>
  leaveRoom,                // (jid: string) => Promise<void>
  createQuickChat,          // (nickname, topic?, invitees?) => Promise<string>
  getRoom,                  // (jid: string) => Room | undefined
  setActiveRoom,            // (jid: string | null) => void
  markAsRead,               // (roomJid: string) => void
  sendMessage,              // (roomJid, body, replyTo?, references?, attachment?) => Promise<string>
  sendReaction,             // (roomJid, messageId, emojis: string[]) => Promise<void>
  sendCorrection,           // (roomJid, messageId, newBody, attachment?) => Promise<void>
  retractMessage,           // (roomJid, messageId) => Promise<void>
  sendChatState,            // (roomJid, state: 'composing' | 'paused') => Promise<void>
  setBookmark,              // (roomJid, { name, nick, autojoin?, password? }) => Promise<void>
  removeBookmark,           // (roomJid: string) => Promise<void>
  setRoomNotifyAll,         // (roomJid, notifyAll, persistent?) => Promise<void>
  inviteToRoom,             // (roomJid, inviteeJid, reason?) => Promise<void>
  inviteMultipleToRoom,     // (roomJid, inviteeJids[], reason?) => Promise<void>
  browsePublicRooms,        // (mucServiceJid?, rsm?) => Promise<{ rooms, pagination }>
  setRoomAvatar,            // (roomJid, imageData, mimeType) => Promise<void>
  clearRoomAvatar,          // (roomJid: string) => Promise<void>
  setDraft,                 // (roomJid, text) => void
  getDraft,                 // (roomJid) => string | undefined
  clearDraft,               // (roomJid) => void
  fetchOlderHistory,        // (roomJid?) => Promise<void> - Scroll-up pagination
} = useRoom()
```

### `useXMPP()`

Low-level access for advanced use cases:

```typescript
const {
  client,        // XMPPClient instance
  sendRawXml,    // (xml: string) => void
  xml,           // xml builder function
  setPresence,   // (show, status?) => void
} = useXMPP()

// Example: Send a custom stanza
const { sendRawXml } = useXMPP()
sendRawXml('<iq type="get" id="ping1"><ping xmlns="urn:xmpp:ping"/></iq>')

// Example: Build and send presence
const { xml, client } = useXMPP()
const presence = xml('presence', {}, xml('show', {}, 'away'))
client?.send(presence)
```

## Types

```typescript
type ConnectionStatus = 'disconnected' | 'connecting' | 'online' | 'reconnecting' | 'error'
type PresenceStatus = 'online' | 'away' | 'dnd' | 'offline'

interface Message {
  id: string
  conversationId: string
  from: string
  body: string
  timestamp: Date
  isOutgoing: boolean
}

interface Conversation {
  id: string
  name: string
  type: 'chat' | 'groupchat'
  unreadCount: number
  lastMessage?: Message
}

interface Contact {
  jid: string
  name: string
  presence: PresenceStatus
  statusMessage?: string
  presenceError?: string      // Error message if presence failed
  subscription: 'none' | 'to' | 'from' | 'both'
  resources?: Map<string, ResourcePresence>  // Per-resource presence
  lastSeen?: Date             // When contact went offline
}

// Per-resource presence (for multi-client tracking)
interface ResourcePresence {
  show: 'chat' | 'away' | 'xa' | 'dnd' | null  // null = online
  status?: string             // Status message
  priority: number            // Presence priority (-128 to 127)
  lastInteraction?: Date      // XEP-0319 idle time
}

interface SubscriptionRequest {
  id: string
  from: string      // Bare JID of requester
  timestamp: Date
}

interface Room {
  jid: string              // Room JID (e.g., room@conference.example.com)
  name: string             // Display name
  nickname: string         // Our nickname in this room
  joined: boolean          // Whether we're currently in the room
  isBookmarked: boolean    // Whether this room is saved as a bookmark
  autojoin?: boolean       // Auto-join on connect (from bookmark)
  occupants: Map<string, RoomOccupant>
  messages: RoomMessage[]
  unreadCount: number
}

interface XmppPacket {
  id: string
  direction: 'incoming' | 'outgoing'
  xml: string
  timestamp: Date
}
```

## Advanced: Direct Store Access

For advanced use cases, you can access Zustand stores directly:

```typescript
import {
  useConnectionStore,
  useChatStore,
  useRosterStore,
  useConsoleStore,
} from '@fluux/sdk'

// Access store state directly
const status = useConnectionStore((state) => state.status)
const messages = useChatStore((state) => state.messages)

// Access store actions
const { setStatus } = useConnectionStore.getState()
```

## Internals

The SDK uses an event-based store binding pattern:

1. **XMPPClient** (`src/core/`) - Handles all XMPP protocol logic, emits events
2. **Zustand Stores** (`src/stores/`) - Hold application state (connection, chat, roster, etc.)
3. **XMPPProvider** (`src/provider/`) - Creates client instance and binds stores via `StoreBindings` interface
4. **React Hooks** (`src/hooks/`) - Expose store state and client methods to components

The SDK can be used without React by accessing stores directly.

## XMPP Features

See [SUPPORTED_XEPS.md](../../SUPPORTED_XEPS.md) for the complete list of implemented XEPs.

**Key features:**

- **Connection**: XEP-0156 (WebSocket discovery), XEP-0198 (Stream Management), XEP-0199 (Ping), XEP-0280 (Message Carbons), Web Push (VAPID via p1:push)
- **Discovery**: XEP-0030 (Service Discovery), XEP-0059 (RSM pagination), XEP-0115 (Entity Capabilities)
- **Roster & Presence**: XEP-0084 (User Avatar), XEP-0153 (vCard Avatars), XEP-0172 (Nickname), XEP-0191 (Blocking), XEP-0319 (Idle time)
- **Messaging**: XEP-0085 (Typing indicators), XEP-0308 (Message Correction), XEP-0313 (MAM), XEP-0363 (HTTP Upload), XEP-0393 (Styling), XEP-0424 (Retraction), XEP-0444 (Reactions), XEP-0461 (Replies)
- **MUC**: XEP-0045 (Multi-User Chat), XEP-0249 (Direct Invitations), XEP-0317 (Hats), XEP-0372 (References/@mentions), XEP-0392 (Consistent Colors), XEP-0402 (Bookmarks)
- **Admin**: XEP-0004 (Data Forms), XEP-0050 (Ad-Hoc Commands), XEP-0133 (Service Administration)

## Requirements

- **React** 18+
- **Zustand** 4+
- **XState** 5+
- **XMPP server** with WebSocket support (wss://)
