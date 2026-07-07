# MUC nick whitespace / impersonation hardening

**Date:** 2026-07-07
**Status:** Approved (design)

## Problem

ejabberd-based MUC components permit occupant nicks with leading and trailing
whitespace. An attacker can join a room as `"admin "` (trailing space) — or with
invisible / zero-width / bidi-control characters — and reuse a trusted user's
avatar. HTML collapses edge whitespace on render, so the nick looks identical to
the real user. The attacker then whispers (XEP-0045 §7.5 private message) the
victim while appearing to be a trusted admin. Openfire strips edge whitespace
server-side; ejabberd does not.

## Threat model

The attacker is a **remote** occupant. Therefore:

- Stripping whitespace from **our own** nick is hygiene — it stops *our* users
  from being the impersonator and normalizes our outgoing presence — but it does
  **not** defend a victim against a remote attacker.
- The defenses that actually protect the victim act at **render time** on remote
  nicks: make the padding *visible*, and make identity *visually distinct*.

Trimming a **remote** occupant's nick for display would *complete* the
impersonation (`"admin "` and `"admin"` both render as `"admin"`) and would break
whisper addressing (the occupants map is keyed by the exact nick). So remote
nicks are never mutated — only revealed.

## Components

### A — Normalize our own nick on join (SDK)

New pure module `packages/fluux-sdk/src/core/nick.ts`:

```ts
// Single source of truth for the "dangerous invisibles" class, shared with the
// display-reveal helper.
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁯­﻿]/g

export function stripNickWhitespace(nick: string): string {
  // Remove zero-width / bidi-control / soft-hyphen chars anywhere, then trim
  // Unicode edge whitespace (JS \s covers NBSP, U+2000–200A, U+3000, tab, etc.).
  return nick.replace(INVISIBLE_CHARS, '').replace(/^\s+|\s+$/gu, '')
}
```

Apply at the **top of `MUC.joinRoom()`** (`packages/fluux-sdk/src/core/modules/MUC.ts`,
~line 573), before `PendingJoin` capture and before building the presence
`to = ${roomJid}/${nickname}`. This is the single choke point covering:

- the join modal and programmatic joins,
- the `/nick` slash command (`apps/fluux/src/commands/registry.ts` dispatches to
  `sdk.joinRoom`),
- reconnection rejoin (`rejoinActiveRooms`).

The modal's existing `nickname.trim()` and the `/nick` handler's `args.trim()`
stay as cheap ASCII input hygiene. `setBookmark()` is intentionally **not**
changed — `joinRoom` strips on every *use* of a bookmark nick, so a padded
stored nick is harmless (YAGNI).

Guard: if stripping yields an empty string, keep the original behavior of the
caller (the `/nick` handler already rejects empty; `joinRoom` should not send an
empty-resource presence — fall back to the un-stripped nick so we never silently
change semantics for an all-whitespace input, which the server will reject
meaningfully).

### B — Reveal edge & invisible whitespace on remote nicks (app)

Pure split helper in `nick.ts` (SDK), sharing `INVISIBLE_CHARS`:

```ts
export interface NickDisplay {
  leading: string   // edge whitespace run (may be '')
  core: string      // middle, internal spaces preserved as-is
  trailing: string
  hasHiddenChars: boolean  // any INVISIBLE_CHARS anywhere in the nick
}
export function splitNickForDisplay(nick: string): NickDisplay
```

App component `apps/fluux/src/components/NickText.tsx`:

- Clean nick → renders the nick verbatim (no wrapper, no cost).
- `leading` / `trailing` present → render as an NBSP gap wrapped in a faintly
  marked span (subtle background/underline) so the padding is *noticeable*, not
  just an easy-to-miss gap. (Pawel's NBSP idea, strengthened with a marker.)
- `hasHiddenChars` → append a small warning glyph/badge with a tooltip
  ("contains hidden characters"). NBSP can't reveal zero-width chars — the badge
  does.

Applied everywhere a **remote** nick is shown:

- occupant list (`OccupantPanel.tsx`),
- message author name (`RoomView.tsx` / message bubble via
  `roomSenderResolution.ts`),
- inline `@mention` pills,
- reply-quote author,
- **the PM / whisper header** — highest priority for this attack.

### C — Color nicks by stable identity (app)

Colors today are seeded from the **nick string**
(`auroraSenderColor(identifier)` in `apps/fluux/src/utils/senderColor.ts`), so a
spoofed nick currently gets the **same** color as the real person.

Introduce a single seed resolver so every color site agrees:

```
seed = occupantId ?? bareJid ?? nick   // XEP-0421 first, real JID next, nick last
```

- `resolveRoomSender` exposes a `senderColorSeed`; the message bubble and reply
  quote pass it to `resolveSenderColor`.
- `resolveNickColor` (mentions) resolves the seed via the room's occupant map.
- `OccupantPanel` seeds from the grouped user's `bareJid` (groups are already
  by bare JID → one color per user across connections).

A spoofed nick with a different `occupantId` then diverges in color from the
real person. **Graceful degradation:** in a fully-anonymous room with no
XEP-0421 support, the seed falls back to the nick and the color defense is
inert — documented limitation. **One-time churn:** re-seeding changes existing
users' colors once; acceptable.

## Testing

- **SDK** (`nick.test.ts`): `stripNickWhitespace` over ASCII space, tab, NBSP,
  U+2000–200A, U+3000, zero-width (U+200B/C/D), bidi controls, soft hyphen,
  mixed, all-whitespace (empty result), and clean nick (no-op). `joinRoom` sends
  presence to the stripped `room/nick`.
- **SDK**: `splitNickForDisplay` — clean, leading-only, trailing-only, both,
  internal-space-preserved, hidden-char detection.
- **App**: `NickText` renders a marker for padded nicks and a badge for hidden
  chars; verbatim for clean nicks. `resolveNickColorSeed` fallback chain
  (occupantId → bareJid → nick) and that a spoof gets a different color than the
  real occupant.

## Out of scope

- Look-alike-occupant detection / active warning on PM start (considered, cut).
- Normalizing stored bookmark nick data.
- Server-side stripping (that is ejabberd's responsibility).
