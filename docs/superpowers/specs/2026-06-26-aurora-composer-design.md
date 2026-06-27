# Aurora Composer — Design Spec

Date: 2026-06-26
Slice: #2 of the Aurora screen rollout (the message composer)
Branch: `claude/aurora-composer-headers`

## Context

The composer is the most-used control in the app, yet it is the least Aurora-styled surface: a borderless `bg-fluux-hover` bar with no focus affordance, an icon-only send button, and reply/edit/whisper context bars stacked above it. The chat/room **headers are already Aurora** (the name `<h2>` inherits the Inter Tight display font via the base `h1-h6` rule; presence is shown on the avatar dot; the action row is a working container-query layout), so this slice is the composer only.

There is **one shared composer**, `MessageComposer.tsx`, consumed by two thin wrappers:
- `MessageInput` (inside `ChatView.tsx`) — 1:1 and group-chat.
- `RoomMessageInput` (inside `RoomView.tsx`) — rooms (adds mention overlay, whisper mode, poll creator).

Both delegate every pixel to `MessageComposer`, so styling it once covers 1:1 **and** rooms.

## Goal

Make the composer a contained Aurora card with a signature accent focus-edge, a filled accent send button, the reply/edit/whisper context unified inside the card, and a calm, escalating end-to-end-encryption reminder — all without regressing the composer's render-perf contract.

## Scope

**In scope (all in the shared `MessageComposer`, so 1:1 + rooms both get it):**
1. Contained card: hairline border at rest, bumped radius.
2. Accent focus-edge on focus (CSS `:focus-within`, zero JS).
3. Filled accent send button (retires the icon-only send + its corner encryption badge).
4. Reply/edit/whisper context unified **inside** the card; the reply chip colored by the replied-person's `auroraSenderColor`.
5. Encryption reminder: a calm teal leading lock when encrypted, escalating to a docked amber "key changed — verify" row.

**Out of scope (explicit):**
- The chat/room **headers** (already Aurora).
- **Density-aware** composer min-height — deferred to slice #3 (density modes). Keep the current `min-height: 44px` / `max-height: 200px`.
- Any change to send/typing/attachment/poll **logic** — this is a presentation slice.
- The emoji picker and attach menu internals (only their button styling participates in the action cluster).

## Design

### 1. Contained card

The visible bar (today `MessageComposer.tsx:809`, `bg-fluux-hover rounded-lg`) becomes a contained card:
- Keep the `bg-fluux-hover` background (L3 elevation, already correct).
- Add a **hairline border** at rest: `1px solid var(--fluux-border)`.
- Bump the radius to the large token (~14px; use `--fluux-radius-l` / `rounded-xl`).
- The card stays inset by the form's existing `px-4` padding (no edge-to-edge change needed).

Introduce a single CSS class (e.g. `.composer-card`) in `index.css` carrying the resting border, radius, and the focus rule below, so the styling lives in one named place rather than scattered utilities.

### 2. Accent focus-edge (the signature)

On focus, the card border becomes the accent and gains a soft accent ring:

```css
.composer-card:focus-within {
  border-color: var(--fluux-brand);
  box-shadow: 0 0 0 3px hsla(var(--fluux-accent-h), var(--fluux-accent-s), var(--fluux-accent-l), 0.22);
}
```

`:focus-within` is pure CSS — it requires **no focus-state JS and no re-render**, so it cannot touch the typing hot path. The light theme uses the same tokens (which already invert), so no separate light rule is needed beyond confirming the ring reads on the light card.

### 3. Filled accent send button

Replace the icon-only send (`MessageComposer.tsx:926`, `text-fluux-brand` `<Send>`) with a **filled accent button**: solid `var(--fluux-brand)` background, white icon, the large-ish radius of the icon buttons. States:
- **Enabled** (text or attachment present): filled accent.
- **Disabled** (empty / sending / disabled): muted fill (`bg-fluux-hover`-equivalent + `text-fluux-muted`), `cursor-not-allowed`, as today.

The current **send-button encryption badge overlay** (the corner `ShieldCheck`/`Lock`) is **removed** — the encryption story moves entirely to the leading lock (§5), so the send button is purely the send affordance.

### 4. Context docked inside the card

Today the edit/reply/whisper context renders as separate bars *above* the pill, and the pill switches to `rounded-b-lg` to fake a join. Instead, the context and the input live **inside one bordered card**:
- The context chip sits at the top of the card, separated from the input row by a hairline divider (`border-b var(--fluux-border)`), keeping its 2px accent **left-edge** marker.
- The card's outer border + radius wrap the whole thing; no `rounded-t`/`rounded-b` swapping.

**Reply-chip hue (the (a) consistency touch):** when replying, color the chip's sender name + left-edge with the **replied-person's** `auroraSenderColor`, so the composer's reply chip matches the in-thread reply chips shipped in slice #1. The wrapper already holds the `replyingTo` message; it passes the resolved color (or the bare JID for the composer to resolve) into `MessageComposer`. Edit context keeps its existing green/red semantics; whisper keeps its violet.

### 5. Encryption reminder — calm leading lock, escalating

A **leading lock** sits in the left cluster, after the attach `+` and before the input. It reads the existing `encryptionState` prop (already passed to `MessageComposer`; it previously drove the send badge). State mapping:

| Conversation state | Indicator |
|---|---|
| **Not encrypted** (default; no/!encrypted `encryptionState`) | **Nothing** — no lock. The composer is clean by default. |
| **Encrypted, not verified** (TOFU / pinned-unchanged) | Calm teal `Lock` (`--fluux-accent-2`). |
| **Encrypted, verified** | Teal `ShieldCheck` (`--fluux-accent-2`). |
| **Needs attention** (peer key changed) | Lock turns amber **and** a docked **escalation row** appears at the top of the card: amber `ShieldAlert` + "Key changed — verify", the verify action inline. |

The leading lock is tappable, routing to the existing trust/verify UI (same target the old badge implied). The escalation row reuses the docked-context slot (§4) styling, in amber (`--fluux-status-warning` family).

> **Flag for review:** prior security-iconography guidance favors a *neutral gray* lock for TOFU (reserving color for verified) to avoid over-signaling trust. The approved mockup uses teal for both TOFU (lock) and verified (shield-check), distinguishing them by icon, not color. This spec follows the approved mockup. If you'd prefer TOFU neutral-gray with teal reserved for verified, say so on spec review and it is a one-line token change.

### 6. Scope of change across 1:1 vs rooms

All of the above is in `MessageComposer`, so both wrappers inherit it. The **whisper banner** (rendered by `RoomView` just outside `MessageComposer`) should visually align with the new docked-context styling so a whisper + the card read as one unit; this is the only wrapper-level touch.

## Render-perf constraints (binding)

- **No new store subscriptions.** The encryption state and reply color are already available to / passed through the wrappers; thread them as props.
- **No new prop that changes on every keystroke.** `encryptionState` and the reply color change only on conversation/reply change, not on typing — safe for the memoized `MessageComposer`.
- The **`composer-active`** mechanism (CSS-only hiding of per-message hover toolbars while composing; `index.css:687`, toggled in `ChatView`/`RoomView`) is **untouched**.
- The focus-edge is `:focus-within` CSS — **no focus-state React state**.
- `messageRowMemo.test.tsx` must stay green (the composer changes must not cause message rows to re-render).

## Accessibility

- Focus-edge: the accent border + ring must be visibly distinct from the resting hairline (the 3px ring at 0.22 alpha clears the 3:1 UI-component contrast against the card in both themes — verify in light).
- Leading lock / shield icons: non-text UI graphics, ≥3:1 against the card background (teal `--fluux-accent-2` and the amber clear this; verify light).
- Escalation row text ("Key changed — verify"): ≥4.5:1 (AA body text) in both themes.
- Filled send: white icon on accent fill ≥3:1 (the AA-tuned accent already clears this from slice #1).
- The leading lock has an accessible label (e.g. `aria-label="End-to-end encrypted"` / "verified" / "key changed, verify") and the escalation verify control is keyboard-reachable.

## Testing

**Unit (`MessageComposer.test.tsx`, extend):**
- Card renders the `.composer-card` class (resting border/radius present).
- Send button: filled variant when sendable; disabled/muted when empty.
- Leading lock: **absent** when not encrypted; teal `Lock` when encrypted-unverified; `ShieldCheck` when verified; amber escalation row present when key-changed.
- Reply context renders **inside** the card; the reply chip's color equals the replied-person's `auroraSenderColor` for a given JID (the (a) touch).
- No send-button encryption badge remains.

**Render-perf:** `messageRowMemo.test.tsx` stays green (composer styling must not re-render rows).

**Visual:** regenerate screenshots (the composer appears in the chat/room scenes); add a dedicated composer-states scene (resting, focused, encrypted, replying, key-changed) for visual regression of the CSS-only states the unit tests can't assert.

**Accessibility:** a contrast assertion (in the existing theme-contrast guard or `senderColor`-style helper test) for the escalation-row text and, where practical, the icon/ring contrast.

## Deferred / follow-ups

- Density-aware composer height (slice #3, density modes).
- Header polish, if any (currently judged unnecessary).
- Gradient (vs solid) send fill — solid chosen for small-size legibility; revisit if desired.
