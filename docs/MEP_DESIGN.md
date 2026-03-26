# MEP Design: PubSub Delegation for MUC Rooms

## Problem Statement

MUC rooms need PubSub capabilities for features like pinned messages, polls, and shared
file metadata. Today, these features lack a standard storage and notification mechanism
within XMPP group chats.

The challenge is architectural: `mod_pubsub` runs as a separate service
(`pubsub.example.com`), completely independent from MUC rooms
(`room@conference.example.com`). A PubSub IQ sent to a room JID returns
`service-unavailable` — the MUC service does not handle PubSub protocol.

XEP-0316 (MUC Eventing Protocol) proposed making room JIDs act as PubSub services, but
it was Deferred with no known implementations. XEP-0369 (MIX) redesigns group chat
entirely around PubSub nodes but is Experimental and not production-ready.

We need an approach that:
- Lets clients send standard PubSub IQs to room JIDs
- Reuses the existing `mod_pubsub` storage and notification infrastructure
- Keeps `mod_pubsub` generic (no MUC-specific logic)
- Supports multiple independent use cases (pins, polls, files) with different access rules

## Architecture: PubSub Service Delegation

The core idea: `mod_pubsub` becomes a multi-tenant storage and notification backend.
XMPP services (like MUC) register as delegates, claiming a service partition within
`mod_pubsub`. Each delegate controls access and notification routing for its partition,
while `mod_pubsub` handles all storage, item management, and protocol mechanics.

From the client's perspective, the room JID is the PubSub service. Internally, the MUC
module intercepts PubSub IQs and forwards them to `mod_pubsub` through the delegation
layer.

## Storage Model

Data is organized as a four-level hierarchy: `{Service, Scope, Namespace, ItemId}`.

```
mod_pubsub (pubsub.example.com)
│
├─ service: default                       — Standard user-facing PubSub
│   ├─ scope: user1@example.com           — PEP model: scope = user bare JID
│   │   ├─ namespace: urn:xmpp:microblog:0 → [post-1, post-2]
│   │   └─ namespace: urn:xmpp:bookmarks:1 → [room1@conf]
│   └─ scope: user2@example.com
│       └─ ...
│
├─ service: muc                           — Delegated to mod_muc_pubsub
│   ├─ scope: room1@conf                  — MEP model: scope = room JID
│   │   ├─ namespace: urn:xmpp:pins:0     → [msg-1, msg-2]
│   │   └─ namespace: urn:xmpp:polls:0    → [poll-1]
│   ├─ scope: room2@conf
│   │   └─ namespace: urn:xmpp:pins:0     → [msg-5]
│   └─ ...
│
├─ service: another-module                — Delegated to another module
│   └─ ...
```

Each level has a clear role:

| Level       | Role                                                                 |
|-------------|----------------------------------------------------------------------|
| **Service** | The registered delegate. Determines IQ routing and access semantics. |
| **Scope**   | The context entity. User JID for PEP, room JID for MEP.             |
| **Namespace** | The PubSub node name. Identifies the data type (pins, polls, etc). |
| **ItemId**  | The individual item within a namespace+scope.                        |

The scope is determined by the service:
- **default** service: scope = user bare JID (standard PEP model, existing behavior)
- **muc** service: scope = room JID (MEP model)

From the client's perspective, the mapping to XMPP stanzas is:
- `to` address determines **service** and **scope** (e.g., `to="room1@conf"` → service=muc, scope=room1@conf)
- `node` attribute maps to **namespace** (e.g., `node="urn:xmpp:pins:0"`)
- `<item id="...">` maps to **itemId**

## Registration API

A service registers once with `mod_pubsub`. The registration is the only contract between
the delegate and `mod_pubsub`.

```erlang
%% mod_muc_pubsub registers on startup
mod_pubsub:register_service(Host, #{
    service => <<"muc">>,
    module => mod_muc_pubsub
}).
```

Key properties:
- Service registration is mandatory for any delegate
- One registration per service, not per namespace or per scope
- `mod_pubsub` maintains a registry of `{Service → Module}` mappings
- Registered services are protected: external user IQs cannot create nodes in a
  delegated service's partition
- Adding new namespaces (pins, polls, files) does NOT require re-registration — the
  delegate manages its own namespace logic internally
- A service can limit itself to a single namespace (simple case) or support many

## Delegate Callbacks

`mod_pubsub` calls the delegate module for two purposes: access control and notification
routing. The delegate receives the full context (`Scope` and `Namespace`) to make
decisions.

### Access Control

```erlang
-callback check_access(Operation, From, Scope, Namespace) -> allow | deny.
```

`mod_pubsub` calls this before any operation on a delegated node. The delegate decides
based on scope (which room) and namespace (which data type):

```erlang
%% Pins: only moderators can publish
check_access(publish, From, RoomJid, <<"urn:xmpp:pins:0">>) ->
    is_moderator_or_above(From, RoomJid);

%% Polls: any participant can create
check_access(publish, From, RoomJid, <<"urn:xmpp:polls:0">>) ->
    is_member_or_above(From, RoomJid);

%% All namespaces: any room member can read
check_access(read, From, RoomJid, _Namespace) ->
    is_member_or_above(From, RoomJid).
```

### Notification Routing

```erlang
-callback route_notify(Scope, Namespace, Item, Event) -> ok.
```

Called by `mod_pubsub` instead of its default subscriber-based delivery. The MUC
delegate broadcasts to room occupants:

```erlang
route_notify(RoomJid, _Namespace, _Item, Event) ->
    mod_muc:broadcast(RoomJid, Event).
```

## IQ Routing

The preferred client API sends PubSub IQs directly to the room JID, making the room
appear as a PubSub service (XEP-0316 compatible):

```xml
<!-- Client pins a message -->
<iq type="set" to="room@conference.example.com" id="pin1">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <publish node="urn:xmpp:pins:0">
      <item id="msg-stanza-id-123">
        <pin xmlns="urn:xmpp:pins:0">
          <pinned-by>user@example.com</pinned-by>
          <pinned-at>2026-03-26T10:00:00Z</pinned-at>
        </pin>
      </item>
    </publish>
  </pubsub>
</iq>
```

Internally, `mod_muc_room` intercepts PubSub-namespaced IQs and translates them to
delegated calls:

```
Client IQ (to room JID, node="urn:xmpp:pins:0", item="msg-123")
    ↓
mod_muc_room: intercepts PubSub IQ
    ↓
mod_muc_pubsub: determines scope=room JID, checks access
    ↓
mod_pubsub: stores item under {service=muc, scope=roomJid, ns=pins, id=msg-123}
    ↓
mod_muc_pubsub: route_notify → broadcasts event to room occupants
```

## mod_muc_pubsub Module

New ejabberd module that bridges MUC rooms and `mod_pubsub`:

| Responsibility              | Detail                                                              |
|-----------------------------|---------------------------------------------------------------------|
| **Registration**            | Registers `muc` service with `mod_pubsub` on startup               |
| **IQ interception**         | Hooks into `mod_muc_room` to catch PubSub IQs sent to room JIDs    |
| **Access control**          | Implements `check_access/4`: maps room affiliations to permissions  |
| **Notification routing**    | Implements `route_notify/4`: broadcasts to room occupants           |
| **Room lifecycle**          | Auto-creates nodes on first publish, deletes all nodes on room destroy |

The module does NOT contain any PubSub storage or item management logic — all of that
stays in `mod_pubsub`.

## Notification Delivery

Notifications use a broadcast model through the room's existing occupant list:

- When an item is published or retracted, `mod_pubsub` calls the delegate's
  `route_notify` callback
- The MUC delegate broadcasts the PubSub event to all current room occupants using
  `mod_muc:broadcast/2`
- No PubSub subscriptions are managed — the room occupant list IS the subscriber list
- Notification recipients are always in sync with room occupancy (no drift)

This mirrors how MUC already broadcasts subject changes and other room events.

## Access Control

Room affiliations map to PubSub permissions. The delegate defines these rules
per-namespace:

| PubSub Operation   | Required Room Affiliation         | Example Use Case |
|--------------------|-----------------------------------|------------------|
| Read / Query items | Member or occupant                | View pinned messages |
| Publish            | Configurable per namespace        | Pin: moderator+, Poll: any member |
| Retract            | Configurable per namespace        | Unpin: moderator+ |
| Create node        | Automatic (on first publish)      | — |
| Delete node        | Automatic (on room destroy)       | — |

The server enforces access control. Client-side permission checks (hiding UI elements)
are a UX optimization, not a security boundary.

## Node Lifecycle

- **Creation**: Auto-create on first publish. No explicit create IQ needed. Default
  config is applied.
- **Persistence**: Nodes and items persist in `mod_pubsub` database tables. Survive
  server restarts.
- **Cleanup**: When a room is destroyed, `mod_muc_pubsub` deletes all nodes in the
  `muc` service partition scoped to that room JID.
- **Room rename**: Delete old-scoped nodes, re-create under new scope (or treat as
  destroy + create).

## disco#info Integration

When `mod_muc_pubsub` is enabled, rooms advertise PubSub capabilities in disco#info
responses:

```xml
<feature var="http://jabber.org/protocol/pubsub"/>
<feature var="http://jabber.org/protocol/pubsub#publish"/>
<feature var="http://jabber.org/protocol/pubsub#retract"/>
<feature var="http://jabber.org/protocol/pubsub#retrieve-items"/>
```

Clients can also query disco#items on the room to discover available PubSub nodes:

```xml
<item jid="room@conference.example.com" node="urn:xmpp:pins:0" name="Pinned Messages"/>
```

## Pinned Messages as First Use Case

The pinned messages protocol is built on top of the delegation architecture:

| Aspect     | Value                                                                    |
|------------|--------------------------------------------------------------------------|
| Namespace  | `urn:xmpp:pins:0`                                                       |
| Item ID    | Message's `stanza-id` (XEP-0359)                                        |
| Payload    | `<pin xmlns="urn:xmpp:pins:0"><pinned-by>{jid}</pinned-by><pinned-at>{iso-timestamp}</pinned-at></pin>` |
| Pin        | Publish item to `urn:xmpp:pins:0` node on room JID                      |
| Unpin      | Retract item from `urn:xmpp:pins:0` node on room JID                    |
| Fetch pins | Query items from `urn:xmpp:pins:0` node on room JID                     |
| Notify     | PubSub event broadcast to all room occupants via `route_notify`          |
| Access     | Publish/retract: moderator or above. Read: any member.                   |

### Client workflow

1. **On room join**: Query `urn:xmpp:pins:0` items to load current pins
2. **Pin a message**: Publish item with stanza-id as item ID
3. **Unpin a message**: Retract item by stanza-id
4. **Real-time updates**: Receive PubSub event broadcasts for pin/unpin by other users
5. **UI**: Pin icon on pinned messages, pinned messages panel, pin/unpin in message
   context menu (moderators only)

### Example stanzas

Pin a message:
```xml
<iq type="set" to="tech@conference.example.com" id="pin1">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <publish node="urn:xmpp:pins:0">
      <item id="stanza-id-of-original-message">
        <pin xmlns="urn:xmpp:pins:0">
          <pinned-by>admin@example.com</pinned-by>
          <pinned-at>2026-03-26T14:30:00Z</pinned-at>
        </pin>
      </item>
    </publish>
  </pubsub>
</iq>
```

Unpin a message:
```xml
<iq type="set" to="tech@conference.example.com" id="unpin1">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <retract node="urn:xmpp:pins:0" notify="true">
      <item id="stanza-id-of-original-message"/>
    </retract>
  </pubsub>
</iq>
```

Fetch all pins:
```xml
<iq type="get" to="tech@conference.example.com" id="pins1">
  <pubsub xmlns="http://jabber.org/protocol/pubsub">
    <items node="urn:xmpp:pins:0"/>
  </pubsub>
</iq>
```

Pin notification (broadcast to occupants):
```xml
<message from="tech@conference.example.com" to="user@example.com">
  <event xmlns="http://jabber.org/protocol/pubsub#event">
    <items node="urn:xmpp:pins:0">
      <item id="stanza-id-of-original-message">
        <pin xmlns="urn:xmpp:pins:0">
          <pinned-by>admin@example.com</pinned-by>
          <pinned-at>2026-03-26T14:30:00Z</pinned-at>
        </pin>
      </item>
    </items>
  </event>
</message>
```

## Prior Art

- **ejabberd MUC/Sub** (`urn:xmpp:mucsub:0`): Fixed set of event subscription nodes
  (messages, presence, affiliations, subject, config) with PubSub framing for delivery.
  Inspiration for the broadcast notification model. However, MUC/Sub does not support
  arbitrary PubSub nodes on rooms.

- **Movim**: Uses global PubSub services (`pubsub.movim.eu`) for communities. Links MUC
  rooms to PubSub nodes via `muc#roomconfig_pubsub` configuration field. No PubSub on
  room JIDs.

- **XEP-0316 (MUC Eventing Protocol)**: Full specification for room JIDs as PubSub
  services with arbitrary nodes. Status: Deferred. No known implementations.

- **XEP-0369 (MIX)**: Complete redesign of group chat where channels are fundamentally
  sets of PubSub nodes. Status: Experimental. Tigase has an experimental implementation.
  Not production-ready.

- **XEP-0503 (Server-side Spaces)**: PubSub nodes that cluster groupchat rooms together.
  Complementary pattern (PubSub containing room references, not PubSub on rooms).

## Changes to mod_pubsub

The delegation architecture requires minimal changes to `mod_pubsub`:

1. **Service registry**: Maintain a map of `{ServiceName → CallbackModule}`. Populated
   via `register_service/2` calls from delegate modules on startup.

2. **Storage partitioning**: Node storage gains a `service` field. Default value is
   `<<"default">>` for backward compatibility. Lookups become
   `{Host, Service, Scope, Namespace}`.

3. **Delegation routing**: Before processing an operation, check if the target service
   has a registered delegate. If yes, call `Module:check_access/4` before proceeding and
   `Module:route_notify/4` instead of default notification delivery.

4. **Namespace protection**: Reject external IQ attempts to create nodes in a delegated
   service's partition.

All existing behavior for the default service remains unchanged. The delegation layer is
opt-in and only activated when modules register services.
