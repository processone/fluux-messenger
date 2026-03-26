# Proto-XEP: Client-Side Polls via Reactions

**Namespace:** `urn:fluux:poll:0`
**Dependencies:** XEP-0444 (Message Reactions), XEP-0045 (MUC), XEP-0428 (Fallback Indication), XEP-0334 (Message Processing Hints), XEP-0313 (MAM), XEP-0421 (Occupant Id)
**Status:** Experimental (client-side implementation)

---

## 1. Introduction

This document describes a protocol for creating and managing polls in XMPP Multi-User Chat (MUC) rooms. The design leverages existing XEP-0444 reactions as the voting mechanism — each poll option maps to an emoji, and voting is simply reacting with that emoji.

This approach has several advantages:

- **Incremental deployment:** Works today with any MUC service that supports XEP-0444 reactions. No server modifications required.
- **Legacy compatibility:** Non-poll-aware clients see a readable text fallback and can vote by sending numbered-emoji reactions.
- **Future server enforcement:** The wire format is designed so that a future MUC component or server module can enforce voting rules (single vote, deadline lock, result broadcast) without changing the client protocol.

### 1.1 Motivation

Polls are a natural fit for group chat. They allow participants to quickly gather opinions, make decisions, or vote on topics. While several proprietary chat platforms offer polling features, XMPP lacks a standardized approach.

By building on XEP-0444 reactions, this protocol avoids introducing a new voting transport and instead reuses an existing, well-understood mechanism. The poll metadata (question, options, settings) is carried as a structured XML element alongside a human-readable fallback body.

---

## 2. Requirements

- The sending client MUST support XEP-0444 (Message Reactions).
- The MUC room MUST support XEP-0444 reactions for voting to work.
- The sending client SHOULD support XEP-0428 (Fallback Indication) to mark the text body as a fallback.
- The sending client SHOULD include XEP-0334 `<store/>` hints to ensure poll messages are archived.

---

## 3. Poll Message

A poll is sent as a `<message type="groupchat">` containing a `<poll>` element in the `urn:fluux:poll:0` namespace.

### 3.1 XML Schema

```xml
<message to="room@conference.example.com" type="groupchat" id="poll-msg-1">
  <body>📊 Poll: What for lunch?
1️⃣ Pizza
2️⃣ Sushi
3️⃣ Tacos</body>

  <poll xmlns="urn:fluux:poll:0" allow-multiple="false">
    <title>What for lunch?</title>
    <option emoji="1️⃣">Pizza</option>
    <option emoji="2️⃣">Sushi</option>
    <option emoji="3️⃣">Tacos</option>
  </poll>

  <fallback xmlns="urn:xmpp:fallback:0" for="urn:fluux:poll:0">
    <body/>
  </fallback>
  <store xmlns="urn:xmpp:hints"/>
</message>
```

### 3.2 `<poll>` Element

| Attribute        | Type              | Required | Description                                                                                    |
|------------------|-------------------|----------|------------------------------------------------------------------------------------------------|
| `allow-multiple` | boolean           | No       | If `"true"`, voters may select more than one option. Defaults to `"false"` (single-vote mode). |
| `hide-results`   | boolean           | No       | If `"true"`, results are hidden from voters until they have voted. Defaults to `"false"`.      |
| `deadline`       | string (ISO 8601) | No       | Deadline after which voting is blocked. Clients SHOULD refuse to submit votes after this time. |

### 3.3 Child Elements of `<poll>`

| Element         | Required | Description                                                                                                          |
|-----------------|----------|----------------------------------------------------------------------------------------------------------------------|
| `<title>`       | Yes      | The poll question or title. MUST be non-empty.                                                                       |
| `<description>` | No       | Optional longer description providing context for the poll.                                                          |
| `<option>`      | Yes (2+) | A poll option. At least 2 options are required. Each option has an `emoji` attribute and text content for the label. |

### 3.4 `<option>` Element

| Attribute | Type   | Required | Description                                                                                                                                |
|-----------|--------|----------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `emoji`   | string | Yes      | The emoji that represents this option. When using the default numbered set, this is `1️⃣`–`9️⃣`. Custom emojis are allowed. |

The text content of `<option>` is the human-readable label for the option.

### 3.5 Default Emoji Set

When no custom emojis are specified, options use the standard numbered emoji sequence:

| Index | Emoji |
|-------|-------|
| 0     | 1️⃣   |
| 1     | 2️⃣   |
| 2     | 3️⃣   |
| 3     | 4️⃣   |
| 4     | 5️⃣   |
| 5     | 6️⃣   |
| 6     | 7️⃣   |
| 7     | 8️⃣   |
| 8     | 9️⃣   |

The default set supports up to 9 options. Custom emojis allow unlimited options.

### 3.6 Fallback Body

The `<body>` element contains a human-readable text representation of the poll for legacy clients:

```
📊 Poll: What for lunch?
1️⃣ Pizza
2️⃣ Sushi
3️⃣ Tacos
```

If a description is present, it appears on the second line:

```
📊 Poll: What for lunch?
Pick your favorite option
1️⃣ Pizza
2️⃣ Sushi
3️⃣ Tacos
```

A `<fallback xmlns="urn:xmpp:fallback:0" for="urn:fluux:poll:0">` element (XEP-0428) SHOULD be included so that poll-aware clients know to strip the fallback body and render the structured poll UI instead.

---

## 4. Voting

Voting is performed using XEP-0444 Message Reactions. To vote for an option, a participant sends a reaction containing the option's emoji, targeted at the poll message ID.

### 4.1 Single-Vote Mode (`allow-multiple="false"`)

In single-vote mode, a client MUST ensure that the user's reaction set contains at most one poll-option emoji. When voting for a new option:

1. Remove all poll-option emojis from the current reaction set.
2. Add the newly selected emoji.
3. Preserve any non-poll emojis (e.g., 👍 thumbs-up on the poll message).

If the user clicks an already-selected option, it is toggled off (removed), resulting in no poll vote.

**Example:** User currently has reactions `[1️⃣, 👍]` and votes for option 2:
- Remove `1️⃣` (poll emoji)
- Keep `👍` (non-poll emoji)
- Add `2️⃣`
- Send reactions: `[👍, 2️⃣]`

### 4.2 Multi-Vote Mode (`allow-multiple="true"`)

In multi-vote mode, clicking an option toggles it on or off in the user's reaction set, independently of other options.

**Example:** User currently has reactions `[1️⃣, 3️⃣]` and clicks option 1:
- Toggle off `1️⃣`
- Send reactions: `[3️⃣]`

### 4.3 Deadline Enforcement

If the `deadline` attribute is present and the current time is past the deadline, clients SHOULD NOT send vote reactions. The UI should indicate that voting has ended.

Note: Deadline enforcement is currently client-side only. A future server-side component could reject reaction stanzas on expired polls.

### 4.4 Wire Format (XEP-0444)

A vote is a standard XEP-0444 reactions stanza:

```xml
<message to="room@conference.example.com" type="groupchat" id="vote-1">
  <reactions xmlns="urn:xmpp:reactions:0" id="poll-msg-1">
    <reaction>2️⃣</reaction>
    <reaction>👍</reaction>
  </reactions>
  <store xmlns="urn:xmpp:hints"/>
</message>
```

The `id` attribute on `<reactions>` references the original poll message ID.

---

## 5. Closing a Poll

The poll creator can close a poll at any time by sending a `<poll-closed>` message to the room. This serves as the authoritative final result.

### 5.1 XML Schema

```xml
<message to="room@conference.example.com" type="groupchat" id="close-msg-1">
  <body>📊 Poll closed: What for lunch?
1️⃣ Pizza: 3
2️⃣ Sushi: 7
3️⃣ Tacos: 1</body>

  <poll-closed xmlns="urn:fluux:poll:0" message-id="poll-msg-1">
    <title>What for lunch?</title>
    <tally emoji="1️⃣" label="Pizza" count="3"/>
    <tally emoji="2️⃣" label="Sushi" count="7"/>
    <tally emoji="3️⃣" label="Tacos" count="1"/>
  </poll-closed>

  <fallback xmlns="urn:xmpp:fallback:0" for="urn:fluux:poll:0">
    <body/>
  </fallback>
  <store xmlns="urn:xmpp:hints"/>
</message>
```

### 5.2 `<poll-closed>` Element

| Attribute    | Type   | Required | Description                                       |
|--------------|--------|----------|---------------------------------------------------|
| `message-id` | string | Yes      | The ID of the original poll message being closed. |

### 5.3 Child Elements of `<poll-closed>`

| Element         | Required | Description                                                                 |
|-----------------|----------|-----------------------------------------------------------------------------|
| `<title>`       | Yes      | The original poll title (for display without needing the original message). |
| `<description>` | No       | The original poll description, if any.                                      |
| `<tally>`       | No (0+)  | One per option, containing the final vote count.                            |

### 5.4 `<tally>` Element

| Attribute | Type    | Required | Description                                                                                                    |
|-----------|---------|----------|----------------------------------------------------------------------------------------------------------------|
| `emoji`   | string  | Yes      | The option emoji.                                                                                              |
| `label`   | string  | No       | The option label text (for display alongside the emoji).                                                       |
| `count`   | integer | Yes      | The number of votes for this option. MUST be non-negative.                                                     |
| `voters`  | string  | No       | Comma-separated list of voter nicknames/occupant identifiers. Enables reaction reconciliation on receiving clients. |

### 5.5 Creator-Only Action

Only the poll creator's client should send `<poll-closed>` messages.

### 5.6 Receiving Client Verification

When a client receives a `<poll-closed>` message, it SHOULD verify the message against the original poll before accepting it. If the original poll message is available in the local store, the following checks MUST all pass:

1. **Creator identity:** The sender of the `<poll-closed>` message must match the creator of the original poll. Comparison uses XEP-0421 occupant-id when both messages carry one (stable across nick changes); otherwise falls back to MUC nickname comparison.
2. **Title match:** The `<title>` in `<poll-closed>` must exactly match the original poll's `<title>`.
3. **Emoji validity:** Every `emoji` attribute in the `<tally>` elements must correspond to an `<option>` emoji in the original poll. A subset is acceptable (options with zero votes may be omitted), but unknown emojis cause rejection.

If any check fails, the `pollClosed` data is discarded and the message is treated as a regular groupchat message.

### 5.7 Deferred Verification via MAM

If the original poll message is not available in the local store (e.g., the client joined the room after the poll was created), the client SHOULD:

1. **Accept on trust** — display the `<poll-closed>` results immediately to avoid blocking the UI.
2. **Fetch the original** — query the room's message archive (XEP-0313) for the original poll message using the `{urn:xmpp:mam:2}ids` form field with the `message-id` value.
3. **Verify retroactively** — once the original poll is retrieved, apply the same verification checks from section 5.6. If verification fails, strip the `pollClosed` data from the message.

This ensures that late-joining clients still benefit from creator verification without blocking on a network round-trip.

---

## 6. Poll Checkpoints

A checkpoint is a snapshot of the current poll results published while the poll remains open. Voting continues after a checkpoint. Checkpoints serve two purposes:

1. **Late-joiner catch-up:** Participants who join after voting has started see an authoritative snapshot without needing to tally reactions themselves.
2. **Reaction reconciliation:** Checkpoint voter lists allow clients to reconcile their local reaction state with the creator's view, healing inconsistencies caused by missed stanzas.

### 6.1 Who Can Send Checkpoints

Checkpoints MAY be sent by:

- **The poll creator's client** — the client that originally sent the `<poll>` message. In the current implementation, the creator's client sends checkpoints automatically based on heuristic rules (see section 6.5).
- **The MUC server** — a future server-side component could generate checkpoints authoritatively, since the server has the definitive reaction state. Server-generated checkpoints would carry the room's own JID as sender rather than a participant's JID.

### 6.2 XML Schema

```xml
<message to="room@conference.example.com" type="groupchat" id="checkpoint-msg-1">
  <body>📊 Poll checkpoint: What for lunch?
1️⃣ Pizza: 3
2️⃣ Sushi: 5
3️⃣ Tacos: 2</body>

  <poll-checkpoint xmlns="urn:fluux:poll:0"
    message-id="poll-msg-1"
    ts="2026-03-26T12:00:00.000Z">
    <title>What for lunch?</title>
    <tally emoji="1️⃣" label="Pizza" count="3" voters="alice,bob,carol"/>
    <tally emoji="2️⃣" label="Sushi" count="5" voters="dave,eve,frank,grace,heidi"/>
    <tally emoji="3️⃣" label="Tacos" count="2" voters="ivan,judy"/>
  </poll-checkpoint>

  <fallback xmlns="urn:xmpp:fallback:0" for="urn:fluux:poll:0">
    <body/>
  </fallback>
  <store xmlns="urn:xmpp:hints"/>
</message>
```

### 6.3 `<poll-checkpoint>` Element

| Attribute    | Type              | Required | Description                                                                                                 |
|--------------|-------------------|----------|-------------------------------------------------------------------------------------------------------------|
| `message-id` | string           | Yes      | The ID of the original poll message this checkpoint refers to.                                              |
| `ts`         | string (ISO 8601) | No       | Timestamp when the checkpoint was computed. Used for ordering — stale checkpoints are discarded (see 6.6). |

### 6.4 Child Elements

The child elements of `<poll-checkpoint>` are identical to `<poll-closed>` (section 5.3): `<title>`, optional `<description>`, and `<tally>` elements. The `voters` attribute on `<tally>` SHOULD be included in checkpoints to enable reaction reconciliation.

### 6.5 Auto-Checkpoint Rules (Client-Side)

When the poll creator's client detects a new vote (via incoming XEP-0444 reactions on the poll message), it evaluates the following conditions before publishing a checkpoint:

1. **Minimum total voters:** At least 5 unique voters must have voted.
2. **Minimum vote delta:** At least 3 new votes must have been cast since the last checkpoint.
3. **Minimum interval:** At least 60 seconds must have elapsed since the last checkpoint.

If all three conditions are met, the client sends a checkpoint. If the interval condition is not yet met but the other conditions are satisfied, the client schedules a debounced re-check after the remaining interval expires.

These thresholds are implementation defaults. A server-side checkpoint generator could use different rules (e.g., checkpoint on every Nth vote, or on a fixed interval).

### 6.6 Receiving and Ordering Checkpoints

When a client receives a `<poll-checkpoint>` message, it processes it as follows:

1. **Timestamp ordering:** If the checkpoint has a `ts` attribute and the original poll message has a `lastCheckpointTs` value, the checkpoint is discarded if `ts <= lastCheckpointTs`. This prevents stale or replayed checkpoints from overwriting newer state.
2. **Verification:** If the original poll is in the local store, the same verification checks as `<poll-closed>` (section 5.6) are applied: creator identity, title match, and emoji validity. If any check fails, the checkpoint is discarded.
3. **Deferred verification:** If the original poll is not in the local store, the checkpoint is accepted on trust (like `<poll-closed>`, see section 5.7) and verified asynchronously via MAM.
4. **Reaction reconciliation:** The voter lists from the checkpoint are merged with the client's local reaction state using a **union-merge** strategy: for each emoji, the set of voters is the union of the checkpoint voters and the locally known voters. This preserves votes that arrived after the checkpoint was computed while incorporating votes the client may have missed.

### 6.7 Server-Side Checkpoints (Future)

A MUC component could generate checkpoints authoritatively:

- The server has the definitive reaction state, eliminating the need for voter lists (though including them aids offline clients).
- Server checkpoints could be sent on a configurable schedule (e.g., every 10 votes, or every 5 minutes).
- Server checkpoints would not require creator verification since the MUC service itself is the sender.
- A server-generated checkpoint could carry an additional `source="server"` attribute to distinguish it from client-generated ones, allowing clients to trust it unconditionally.

---

## 7. Result Query (IQ)

Clients that join a room late or need to verify results can query the poll creator for the current tally via an IQ stanza.

### 7.1 Query

```xml
<iq type="get" to="creator@example.com/resource" id="poll-q1">
  <poll-results xmlns="urn:fluux:poll:0"
    message-id="poll-msg-1"
    room="room@conference.example.com"/>
</iq>
```

| Attribute    | Type   | Required | Description                              |
|--------------|--------|----------|------------------------------------------|
| `message-id` | string | Yes      | The poll message ID to query.            |
| `room`       | string | Yes      | The room JID where the poll was created. |

### 7.2 Response

```xml
<iq type="result" to="requester@example.com/resource" id="poll-q1">
  <poll-results xmlns="urn:fluux:poll:0"
    message-id="poll-msg-1"
    closed="false">
    <tally emoji="1️⃣" label="Pizza" count="3"/>
    <tally emoji="2️⃣" label="Sushi" count="7"/>
    <tally emoji="3️⃣" label="Tacos" count="1"/>
  </poll-results>
</iq>
```

| Attribute | Type    | Description                                      |
|-----------|---------|--------------------------------------------------|
| `closed`  | boolean | Whether the poll has been closed by its creator. |

### 7.3 Error Response

If the creator's client does not recognize the poll (e.g., it was created in a previous session):

```xml
<iq type="error" to="requester@example.com/resource" id="poll-q1">
  <poll-results xmlns="urn:fluux:poll:0" message-id="poll-msg-1"/>
  <error type="cancel">
    <item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/>
  </error>
</iq>
```

### 7.4 Limitations

The IQ query mechanism requires the poll creator to be online. If the creator is offline, clients fall back to tallying results from the locally observed XEP-0444 reactions (best-effort). A future server-side component could provide authoritative results regardless of creator presence.

---

## 8. Result Tallying

Poll results are computed from the reactions map on the poll message. The tallying algorithm differs between single-vote and multi-vote modes to handle malformed votes gracefully.

### 8.1 Multi-Vote Algorithm

In multi-vote mode (`allow-multiple="true"`), all reactions are counted as-is:

```
for each option in poll.options:
  voters = reactions[option.emoji] or []
  count = len(voters)
```

### 8.2 Single-Vote Algorithm

In single-vote mode, a voter who reacted with multiple poll-option emojis (e.g., from a legacy client that does not understand poll semantics) is counted only in their **first option** in option order. This provides graceful best-effort handling without rejecting the vote entirely:

```
assigned = empty set
for each option in poll.options (in order):
  raw_voters = reactions[option.emoji] or []
  voters = [v for v in raw_voters if v not in assigned]
  for v in voters:
    assigned.add(v)
  count = len(voters)
```

**Example:** Alice reacted with both 1️⃣ and 2️⃣ on a single-vote poll. She is counted only in option 1 (the first option in the poll's option order). Her reaction on option 2 is silently ignored.

### 8.3 Total Voters

The total number of unique voters is the union of all voter sets across all options. In multi-vote mode, a single participant who voted for multiple options is counted once.

### 8.4 Hide-Results Mode

When `hide-results="true"`, clients SHOULD NOT display vote counts or progress bars to a participant until they have voted on at least one option. After voting, results are shown normally.

---

## 9. MAM Integration

Poll messages are archived by the MUC service like any other groupchat message (the `<store/>` hint in sections 3.1, 5.1, and 6.2 ensures this). Clients retrieving archived messages via XEP-0313 SHOULD parse `<poll>`, `<poll-closed>`, and `<poll-checkpoint>` elements from MAM results, identically to live message processing.

### 9.1 Fetching a Single Poll Message

A client can retrieve a specific poll message by its archive ID using the `{urn:xmpp:mam:2}ids` form field:

```xml
<iq type="set" to="room@conference.example.com" id="mam-fetch-1">
  <query xmlns="urn:xmpp:mam:2" queryid="mam-fetch-1">
    <x xmlns="jabber:x:data" type="submit">
      <field var="FORM_TYPE" type="hidden">
        <value>urn:xmpp:mam:2</value>
      </field>
      <field var="{urn:xmpp:mam:2}ids">
        <value>poll-msg-archive-id</value>
      </field>
    </x>
    <set xmlns="http://jabber.org/protocol/rsm">
      <max>1</max>
    </set>
  </query>
</iq>
```

This is used for deferred verification (sections 5.7 and 6.6): when a client receives a `<poll-closed>` or `<poll-checkpoint>` message but does not have the original poll in its local store, it fetches the original via this targeted MAM query.

### 9.2 Store-First Lookup

Before making a MAM query, clients SHOULD check their local message store. The store lookup should match against both the client-generated message ID (`id` attribute) and the server-assigned archive ID (`stanza-id`), since the `message-id` in `<poll-closed>` carries the original client ID.

---

## 10. Legacy Client Compatibility

The protocol is designed so that clients unaware of `urn:fluux:poll:0` can still participate:

1. **Viewing polls:** The `<body>` contains a formatted text representation (e.g., `📊 Poll: What for lunch?\n1️⃣ Pizza\n2️⃣ Sushi`). Legacy clients display this as a normal message.

2. **Voting:** A user on a legacy client can vote by sending a numbered-emoji reaction (1️⃣, 2️⃣, etc.) on the poll message. This is the same XEP-0444 mechanism that poll-aware clients use.

3. **Viewing results:** The `<poll-closed>` and `<poll-checkpoint>` messages include a text body with the tally. Legacy clients see these as normal messages.

The `<fallback>` element (XEP-0428) signals to poll-aware clients that the `<body>` is a fallback representation and should be replaced by the structured poll UI.

---

## 11. Security Considerations

### 11.1 Vote Integrity

In the current client-side implementation, voting rules (single-vote, deadline) are enforced locally. A malicious client could:

- Send multiple reactions in single-vote mode.
- Vote after the deadline has passed.
- Spoof vote counts in `<poll-closed>` messages.

These attacks are mitigated by:
- **Single-vote deduplication:** The tallying algorithm (section 7.2) assigns each voter to at most one option, so multiple reactions from a single voter are gracefully handled rather than double-counted.
- **Tally verification:** Clients can independently tally results from the reactions map and compare against `<poll-closed>` data.
- **Server enforcement (future):** A MUC component could enforce single-vote rules by rejecting invalid reaction stanzas, and verify `<poll-closed>` sender identity.

### 11.2 Creator Identity

Receiving clients verify `<poll-closed>` and `<poll-checkpoint>` messages against the original poll (see sections 5.6 and 6.6). The verification checks:

1. **Sender identity** — via XEP-0421 occupant-id (preferred, stable across nick changes) or MUC nickname (fallback).
2. **Content integrity** — title and result emojis must match the original poll.
3. **Deferred verification** — when the original poll is not locally available, clients accept on trust and verify asynchronously via MAM (sections 5.7 and 6.6).

Without server enforcement, these client-side checks rely on the MUC service's existing identity guarantees (occupant-id or full JID binding).

### 11.3 Denial of Service

A participant could create excessive polls to spam a room. This is a general MUC moderation concern and can be addressed by existing room moderation tools (kick, ban, rate limiting).

### 11.4 Privacy

Reaction-based voting is inherently **public** — all participants can see who voted for which option. This is by design for the initial implementation. A future extension could support anonymous voting via server-side aggregation, where the MUC component collects votes and only publishes aggregate counts.

---

## 12. Future Extensions

### 12.1 Server-Side Enforcement

A MUC component module could:
- Validate that reactions on poll messages conform to voting rules.
- Reject duplicate votes in single-vote mode.
- Lock voting after the deadline.
- Broadcast `<poll-closed>` on behalf of the creator when the deadline expires.
- Respond to `<poll-results>` IQ queries authoritatively, eliminating the need for the creator to be online.
- Generate authoritative `<poll-checkpoint>` messages (see section 6.7).

### 12.2 Anonymous Voting

A server-side component could support anonymous polls by:
- Accepting votes via a private IQ to the MUC component (not as public reactions).
- Publishing only aggregate counts to the room, without revealing individual voters.
- Requiring a `<poll anonymous="true">` attribute to enable this mode.

### 12.3 Extended Option Set

The default numbered emoji set (1️⃣–9️⃣) covers up to 9 options. Custom emojis already allow more, but a standardized extended set (🔟 and beyond, or lettered emojis) could be defined for broader compatibility.

### 12.4 Poll Editing

Allow the poll creator to edit the question or options after creation using XEP-0308 (Message Correction). This requires careful handling to avoid invalidating existing votes.

### 12.5 Scheduled Polls

Support for polls that open at a future time, using a `start` attribute alongside `deadline`.

---

## 13. Namespace

The protocol uses the namespace `urn:fluux:poll:0`. The `:0` suffix indicates this is an experimental version. Future standardized versions would use a versioned namespace (e.g., `urn:xmpp:poll:1`) registered with the XMPP Registrar.

---

## 14. XML Schema

```xml
<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           targetNamespace="urn:fluux:poll:0"
           xmlns:tns="urn:fluux:poll:0"
           elementFormDefault="qualified">

  <!-- Poll message element -->
  <xs:element name="poll">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="title" type="xs:string"/>
        <xs:element name="description" type="xs:string" minOccurs="0"/>
        <xs:element name="option" maxOccurs="unbounded" minOccurs="2">
          <xs:complexType>
            <xs:simpleContent>
              <xs:extension base="xs:string">
                <xs:attribute name="emoji" type="xs:string" use="required"/>
              </xs:extension>
            </xs:simpleContent>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
      <xs:attribute name="allow-multiple" type="xs:boolean" default="false"/>
      <xs:attribute name="hide-results" type="xs:boolean" default="false"/>
      <xs:attribute name="deadline" type="xs:dateTime"/>
    </xs:complexType>
  </xs:element>

  <!-- Shared tally type used by poll-closed, poll-checkpoint, and poll-results -->
  <xs:complexType name="tallyType">
    <xs:attribute name="emoji" type="xs:string" use="required"/>
    <xs:attribute name="label" type="xs:string"/>
    <xs:attribute name="count" type="xs:nonNegativeInteger" use="required"/>
    <xs:attribute name="voters" type="xs:string"/>
  </xs:complexType>

  <!-- Poll closed element -->
  <xs:element name="poll-closed">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="title" type="xs:string"/>
        <xs:element name="description" type="xs:string" minOccurs="0"/>
        <xs:element name="tally" type="tns:tallyType" minOccurs="0" maxOccurs="unbounded"/>
      </xs:sequence>
      <xs:attribute name="message-id" type="xs:string" use="required"/>
    </xs:complexType>
  </xs:element>

  <!-- Poll checkpoint element -->
  <xs:element name="poll-checkpoint">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="title" type="xs:string"/>
        <xs:element name="description" type="xs:string" minOccurs="0"/>
        <xs:element name="tally" type="tns:tallyType" minOccurs="0" maxOccurs="unbounded"/>
      </xs:sequence>
      <xs:attribute name="message-id" type="xs:string" use="required"/>
      <xs:attribute name="ts" type="xs:dateTime"/>
    </xs:complexType>
  </xs:element>

  <!-- Poll results IQ payload -->
  <xs:element name="poll-results">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="tally" type="tns:tallyType" minOccurs="0" maxOccurs="unbounded"/>
      </xs:sequence>
      <xs:attribute name="message-id" type="xs:string" use="required"/>
      <xs:attribute name="room" type="xs:string"/>
      <xs:attribute name="closed" type="xs:boolean"/>
    </xs:complexType>
  </xs:element>

</xs:schema>
```

---

## 15. Acknowledgements

This protocol builds on the following extensions:

- **XEP-0444** (Message Reactions) — The voting mechanism.
- **XEP-0045** (Multi-User Chat) — The room environment where polls operate.
- **XEP-0428** (Fallback Indication) — Marking the text body as a fallback for structured content.
- **XEP-0334** (Message Processing Hints) — Ensuring poll messages are stored for MAM retrieval.
- **XEP-0421** (Occupant Id) — Future identity verification for creator-only actions.
