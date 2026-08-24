# Event Hooks API

The Event Hooks API provides an Obsidian-inspired plugin pattern for processing SDK events. Hooks subscribe to SDK events with automatic lifecycle cleanup, enabling modular event handling.

## Concepts

- **EventHook**: Base class with `onload()`/`onunload()` lifecycle and auto-cleanup subscriptions
- **ActivityLogStore**: Persistent historical event feed (subscription requests, invitations, reactions, system events)
- **Hook Registry**: `registerHook()`/`unregisterHook()` on `XMPPClient`

## Creating a Custom Hook

```typescript
import { EventHook, type XMPPClient } from '@fluux/sdk'

class NotificationSoundHook extends EventHook {
  readonly id = 'notification-sound'
  readonly name = 'Notification Sound'

  onload(): void {
    // Subscribe to SDK events, auto-cleaned on unload
    this.registerEvent('chat:message', ({ message }) => {
      if (!message.isOutgoing) {
        playNotificationSound()
      }
    })

    this.registerEvent('events:muc-invitation', ({ roomJid, from }) => {
      playInvitationSound()
    })

    // Subscribe to store changes, also auto-cleaned
    const unsub = someStore.subscribe(
      (state) => state.someValue,
      (value) => { /* react to change */ }
    )
    this.registerStoreSubscription(unsub)
  }

  // Optional: custom cleanup (call super.onunload() to clean subscriptions)
  onunload(): void {
    super.onunload()
    // additional cleanup...
  }
}
```

## Registering Hooks

```typescript
import { XMPPClient, ActivityLogHook } from '@fluux/sdk'

const client = new XMPPClient({ debug: false })

// Register a built-in hook
client.registerHook(new ActivityLogHook(client))

// Register a custom hook
client.registerHook(new NotificationSoundHook(client))

// Unregister by ID
client.unregisterHook('notification-sound')

// Check if registered
const hook = client.getHook('activity-log')
```

For React apps, `XMPPProvider` automatically registers the `ActivityLogHook`.

## Built-in Hooks

### ActivityLogHook

Logs notable events to `activityLogStore`:

| SDK Event | Activity Type | Kind |
|-----------|--------------|------|
| `events:subscription-request` | `subscription-request` | actionable |
| `events:muc-invitation` | `muc-invitation` | actionable |
| `events:system-notification` | `resource-conflict` / `auth-error` / `connection-error` | informational |
| `events:stranger-message` | `stranger-message` | actionable |
| `chat:reactions` (own messages) | `reaction-received` | informational |
| `room:reactions` (own messages) | `reaction-received` | informational |

Reactions are grouped by message. Multiple reactors on the same message consolidate into a single event.

## Activity Log Store

```typescript
import { activityLogStore } from '@fluux/sdk/stores'

// Read events
const events = activityLogStore.getState().events

// Add an event
activityLogStore.getState().addEvent({
  type: 'subscription-request',
  kind: 'actionable',
  timestamp: new Date(),
  resolution: 'pending',
  payload: { type: 'subscription-request', from: 'user@example.com' },
})

// Resolve an actionable event
activityLogStore.getState().resolveEvent(eventId, 'accepted')

// Mark as read
activityLogStore.getState().markRead(eventId)
activityLogStore.getState().markAllRead()

// Mute/unmute event types
activityLogStore.getState().muteType('reaction-received')
activityLogStore.getState().unmuteType('reaction-received')
```

The store is persisted to `localStorage` with a rolling cap of 500 events, scoped by account JID.

## React Hook

```tsx
import { useActivityLog } from '@fluux/sdk'

function ActivityFeed() {
  const {
    events,           // All events, newest first
    unreadCount,      // Unread non-muted events
    actionableEvents, // Pending actionable events
    mutedTypes,       // Set of muted event types
    markRead,         // Mark single event read
    markAllRead,      // Mark all read
    resolveEvent,     // Resolve actionable event
    muteType,         // Mute an event type
    unmuteType,       // Unmute an event type
  } = useActivityLog()

  return (
    <div>
      <h2>Activity ({unreadCount} new)</h2>
      {events.map(event => (
        <div key={event.id} onClick={() => markRead(event.id)}>
          <span>{event.type}</span>
          <span>{event.timestamp.toLocaleString()}</span>
          {event.resolution && <span>{event.resolution}</span>}
        </div>
      ))}
    </div>
  )
}
```

## Activity Event Types

```typescript
interface ActivityEvent {
  id: string                    // UUID
  type: ActivityEventType       // Event category
  kind: 'actionable' | 'informational'
  timestamp: Date
  read: boolean
  muted: boolean                // Derived from mutedTypes
  resolution?: 'pending' | 'accepted' | 'rejected' | 'dismissed'
  payload: ActivityPayload      // Discriminated union
}

type ActivityEventType =
  | 'subscription-request'
  | 'subscription-accepted'
  | 'subscription-denied'
  | 'muc-invitation'
  | 'reaction-received'
  | 'resource-conflict'
  | 'auth-error'
  | 'connection-error'
  | 'stranger-message'
```

## SDK Events for Activity

The SDK emits these events when the activity log changes:

```typescript
// Fired when an event is logged
client.subscribe('activity:event-logged', ({ event }) => {
  console.log('New activity:', event.type)
})

// Fired when an event is resolved
client.subscribe('activity:event-resolved', ({ eventId, resolution }) => {
  console.log('Resolved:', eventId, resolution)
})
```

## Architecture

```
SDK Events (emitSDK)
       │
       ├── Store Bindings ──► Zustand Stores (existing flow)
       │
       └── EventHook ──► ActivityLogStore (new flow)
                            │
                            └── useActivityLog hook ──► React UI
```

The EventHook system layers on top of existing store bindings. Both subscribe to
the same SDK events independently, so hooks can add side effects without
changing updates to existing Zustand stores such as `eventsStore`.

## Available SDK Events

Any event in the `SDKEvents` interface can be subscribed to via `registerEvent()`. See `packages/fluux-sdk/src/core/types/sdk-events.ts` for the full list, including:

- Connection events (`connection:status`, `connection:authenticated`, ...)
- Chat events (`chat:message`, `chat:reactions`, `chat:typing`, ...)
- Room events (`room:message`, `room:reactions`, `room:joined`, ...)
- Roster events (`roster:contact`, `roster:presence`, ...)
- Notification events (`events:subscription-request`, `events:muc-invitation`, ...)
- Blocking events (`blocking:added`, `blocking:removed`, ...)
