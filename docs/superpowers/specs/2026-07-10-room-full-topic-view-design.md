# Room Info modal — view a room's full topic/description (#922)

**Issue:** [#922](https://github.com/processone/fluux-messenger/issues/922) — "No way to view a room's full description when it is too long." Milestone 0.17.1.

## Problem

A MUC room's description (`muc#roomconfig_roomdesc`) is surfaced in the app as `room.subject`. It renders in only one place — the header topic line in `RoomHeader.tsx` — where it is hard-clipped to a single line via Tailwind `truncate`:

```jsx
// apps/fluux/src/components/RoomHeader.tsx:125-130
<div className="flex-1 min-w-0">
  <h2 className="font-semibold text-fluux-text truncate leading-tight">{room.name}</h2>
  <p className="text-xs text-fluux-muted truncate">
    {room.subject ? renderTextWithLinks(room.subject) : room.jid}
  </p>
</div>
```

When the topic exceeds one line, the rest is unreachable — there is no room-info surface that shows it in full. The only existing room modal is the owner-only `RoomConfigModal` (edit/config), which is not a viewing surface for regular members.

## Goal

Give any room member a way to read the complete topic/description, plus a lightweight quick-peek in the header. Keep the change minimal and consistent with existing patterns.

## Non-goals

- No SDK changes. `room.subject` already carries the text.
- No new i18n keys — `rooms.topic`, `chat.showMore`, `chat.showLess` already exist.
- Not adding the topic to the members panel (`OccupantPanel`) — it reads as out of place there.
- Not building a general-purpose room-details surface. The modal is scoped to identity + topic; it can grow later.

## Design

Two complementary changes.

### 1. New `RoomInfoModal` (dedicated viewing area)

New component `apps/fluux/src/components/RoomInfoModal.tsx`, built on the standard `ModalShell` primitive (`title`, `onClose`, `width?`, `children`; provides glass panel, scrim, Escape, focus restore).

Props:
```ts
interface RoomInfoModalProps {
  room: Room
  onClose: () => void
}
```

Content (top to bottom):
- **Identity row**: `RoomAvatar` (existing component) + room `name`.
- **JID**: `room.jid`, shown in muted text with a copy affordance consistent with how JIDs are copied elsewhere (e.g. the occupant "copy JID" toast pattern). Copy is a nice-to-have; if it adds friction, render as selectable text only.
- **Topic block**: label `t('rooms.topic')` ("Topic"), then the full subject rendered with `renderTextWithLinks(room.subject)` inside a container with `whitespace-pre-wrap break-words` so it wraps fully and links stay clickable. When `room.subject` is empty, show a muted `t('rooms.noTopic')`-style placeholder — **verify the key exists**; if not, fall back to an existing empty-state key or add one following the i18n-surgical-edit workflow (all 33 locales, no English placeholders).

**Long-topic collapse (self-contained, no message-list coupling):**
The topic body collapses past ~6 lines using CSS `line-clamp-6` with a local `useState` `expanded` flag and a **Show more / Show less** toggle (`chat.showMore` / `chat.showLess` + `ChevronDown`/`ChevronUp`). The toggle renders only when the content actually overflows, detected by a measure-on-mount + on-resize check (compare `scrollHeight` to `clientHeight` on the clamped element via a ref). This deliberately does **not** reuse `CollapsibleContent`, which requires a `messageId`, `expandedMessagesStore`, and the `messageWidthContext` provider — none of which exist outside the message list. The collapse logic here is ~40 lines and independently testable.

### 2. `RoomHeader` — open the modal + quick-peek tooltip

In `RoomHeader.tsx`:
- Add modal state: `const [showInfoModal, setShowInfoModal] = useState(false)` (matching the existing `showAvatarModal` / `showMembersModal` / `showHatsModal` pattern).
- Make the name+subject block (lines 125-130) a keyboard-accessible **button** (`role="button"`, focusable, `Enter`/`Space`) that calls `setShowInfoModal(true)`. Add a subtle hover affordance (e.g. `hover:bg-fluux-hover` rounded) so the click target is discoverable. Preserve the desktop drag region — the title button must stop the drag interaction from swallowing the click (opt the button out of the drag region as other interactive header controls do).
- Wrap the block (or the subject `<p>`) in the existing `Tooltip` with `content={room.subject}` and `position="bottom"`, rendered only when `room.subject` is present, for an instant hover/long-press peek.
- Render `{showInfoModal && <RoomInfoModal room={room} onClose={() => setShowInfoModal(false)} />}` alongside the other conditionally-rendered modals near the end of the component.

## Data flow

`room` (already available in `RoomHeader`) → `RoomInfoModal` via props. No store or SDK reads beyond the existing `Room` object. The topic value is `room.subject`.

## Error / edge cases

- **No subject**: header shows `room.jid` (unchanged); modal shows the empty-topic placeholder. Header title still opens the modal (useful for JID/avatar).
- **Very long / multi-paragraph subject**: handled by `whitespace-pre-wrap` + line-clamp collapse.
- **Links in subject**: clickable in the modal (`renderTextWithLinks`); not clickable in the tooltip (acceptable — tooltip is a peek).
- **RTL**: rely on existing logical-property utilities; no hardcoded left/right.

## Testing

- **Unit** (`RoomInfoModal.test.tsx`, jsdom env per the app DOM-test convention):
  - Renders room name, JID, and full topic text.
  - With a short topic, no Show more toggle is present.
  - With a long topic (mock `scrollHeight > clientHeight`), the Show more toggle appears and toggling flips to Show less.
  - Empty subject renders the placeholder, not a blank block.
  - New SDK/app exports used by the modal must be added to the app test mock if applicable (none expected here).
- **Manual (demo mode)**: seed a room with a long multi-line topic (via `DemoClient` / storage), open the room, confirm the header tooltip peek and that clicking the title opens the modal showing the full topic with working collapse and clickable links.

## Files touched

- `apps/fluux/src/components/RoomInfoModal.tsx` — new.
- `apps/fluux/src/components/RoomInfoModal.test.tsx` — new.
- `apps/fluux/src/components/RoomHeader.tsx` — modal state, clickable title, tooltip, conditional render.
- i18n: only if a no-topic placeholder key is missing (surgical edit across all locales).

## Rollout

Single PR against a feature branch off `main`, squash-merged. No migration, no config, no SDK rebuild required.
