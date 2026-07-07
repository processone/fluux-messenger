# MUC Slash Commands — Design

Date: 2026-07-07
Status: Approved design, pending implementation plan
Branch: `feat/muc-slash-commands`

## Problem

The app has no real slash-command system. `useSlashCommands.ts` is a hardcoded
`if (command === '/christmas')` chain, and `/me` is not a command at all: it is
sent verbatim on the wire and rendered as an action by `messageGrouping.ts`.
Room moderation (kick, ban, subject, invite, config) is only reachable through
menus and modals. We want a proper, extensible command layer that covers the
common MUC commands, with completion, help, and a composer affordance that shows
when input will be interpreted as a command instead of sent as a message.

## Scope (this design)

Registry + parser infrastructure **and** a core, high-value command set. Deferred
to a follow-up: `/op`, `/deop`, `/voice`, `/mute`, `/whois`, `/ping`, `/clear`,
`/destroy`, `/away`/`/back`, `/msg`/`/query`, and argument (nick) completion.

## Decisions (locked with the maintainer)

1. Registry lives in the **app** (`apps/fluux`); the SDK stays protocol-only.
2. Completion: `/help` command **plus** a command-name completion popover.
   Argument/nick completion is deferred.
3. Destructive moderation (`/kick`, `/ban`) **fires directly** with a toast, not a
   confirmation modal.
4. Modal shortcuts: argless `/invite` opens `InviteToRoomModal`; `/invite <jid>`
   sends directly. `/config` opens `RoomConfigModal` (owner only).
5. `/help` renders as a **transient popover panel** reusing the completion-menu
   styling. No timeline system-message infra in this cut.
6. Privilege gating is **both** client-side and server-authoritative: local
   role/affiliation blocks obvious cases before any stanza is sent AND gates
   menu/help visibility; the server's rejection of anything that slips through is
   surfaced as a toast.
7. Composer indicator: the send button reflects three states — send / run-command
   / unknown — and `/me`, `/say`, and `//` are treated as normal sends.

## Architecture

Four new units in `apps/fluux/src`, each independently testable:

### `commands/parseSlashInput.ts` (pure)

No React, no SDK. Classifies raw composer text:

```ts
type ParsedInput =
  | { kind: 'command'; name: string; args: string }  // /nick bob
  | { kind: 'passthrough'; text: string }             // /me waves  -> send verbatim
  | { kind: 'literal'; text: string }                 // /say ...  or  //...  -> strip escape, send
  | { kind: 'message' }                               // not a command

function parseSlashInput(text: string): ParsedInput
```

Rules:
- Leading `//` -> `literal`, one slash stripped (escape hatch).
- `/say <text>` -> `literal` with `<text>`.
- `/me ` (slash, `me`, space) -> `passthrough` (verbatim, including the `/me`).
- `/<word>` at start with optional args -> `command`.
- Anything else -> `message`.

Note `parseSlashInput` does not know the registry; it only tokenizes. Resolution
against the registry (known / unknown / context / capability) happens in the
dispatcher. This keeps the parser pure and exhaustively unit-testable.

### `commands/types.ts`

```ts
type CommandCapability = 'moderator' | 'admin' | 'owner'
type CommandContextKind = 'chat' | 'room'

interface SlashCommand {
  name: string
  aliases?: string[]
  descriptionKey: string            // i18n, for /help + menu
  usageKey?: string                 // i18n, e.g. "/nick <newnick>"
  contexts: CommandContextKind[]    // where it is valid
  capability?: CommandCapability    // blocks + gates visibility
  passthrough?: boolean             // /me: send verbatim (no run())
  run?(ctx: CommandContext, args: string): Promise<CommandResult>
}

type CommandResult =
  | { ok: true; toast?: string }
  | { ok: false; error: string }    // surfaced as an error toast

interface CommandContext {
  kind: CommandContextKind
  entityJid: string                 // room JID or chat JID
  self?: { role: RoomRole; affiliation: RoomAffiliation }  // room only
  sdk: {
    joinRoom(jid: string, nick: string): Promise<void>
    leaveRoom(jid: string): Promise<void>
    setSubject(jid: string, subject: string): Promise<void>
    setRole(jid: string, nick: string, role: RoomRole, reason?: string): Promise<void>
    setAffiliation(jid: string, userJid: string, aff: RoomAffiliation, reason?: string): Promise<void>
    sendMediatedInvite(jid: string, inviteeJid: string, reason?: string): Promise<void>
  }
  ui: {
    openInviteModal(): void
    openRoomConfig(): void
  }
  resolveNick(nick: string): string | undefined   // nick -> bare JID via occupants
  t: TFunction
}
```

### `commands/registry.ts`

The command definitions. `runCommand(parsed, ctx)` looks a command up by name or
alias, validates `contexts` and `capability`, then calls `run()`.

### `components/composer/CommandMenu.tsx`

The completion popover. Rendered through MessageComposer's existing `aboveInput`
slot (the same mechanism the `@mention` menu uses in RoomView). Triggered only
when composer text is a bare partial command at position 0 (`/^\/(\w*)$/`).
Filters the registry by current context + capability visibility + name/alias
prefix; shows `usage` + `description`. Up/Down move, Enter/Tab complete to
`/name `, Esc dismisses.

## Command set (core cut)

| Command | Context | Capability | Behavior |
| --- | --- | --- | --- |
| `/me <action>` | chat + room | — | Passthrough; sent verbatim. **Never** shows the command indicator. |
| `/say <text>` | chat + room | — | Escape hatch; sends `<text>` literally (so a message can start with `/`). |
| `/help` | chat + room | — | Opens the help popover panel listing commands visible in this context. |
| `/nick <name>` | room | — | `joinRoom(roomJid, name)` (rejoin with new nick). 409/conflict and 406 surfaced as an error toast. |
| `/part` | room | — | `leaveRoom(roomJid)`. Optional status message dropped (SDK has no arg for it). |
| `/topic [text]` | room | — | With text: `setSubject`. Without: toast the current subject. Server may reject; surfaced as toast. |
| `/kick <nick> [reason]` | room | moderator | `resolveNick` then `setRole(nick, 'none', reason)`; result toast. Blocked locally if self is not moderator. |
| `/ban <nick\|jid> [reason]` | room | admin | Resolve to bare JID then `setAffiliation(jid, 'outcast', reason)`; result toast. Blocked locally if self is not admin. |
| `/invite [jid] [reason]` | room | — | With jid: `sendMediatedInvite` + toast. Without: `ui.openInviteModal()`. |
| `/config` | room | owner | `ui.openRoomConfig()`. Blocked locally if self is not owner. |
| `/christmas` | chat + room | — | Existing easter egg, ported onto the registry (no regression). |

## Dispatch flow

In the composer submit path (rewritten `useSlashCommands` / dispatcher):

1. `parseSlashInput(text)`.
2. `message` -> normal send (unchanged path).
3. `passthrough` / `literal` -> normal send of the resolved text (verbatim / escaped).
4. `command` -> `runCommand`:
   - Unknown name, or valid name but wrong `contexts` -> error toast
     ("Unknown command — use /say to send literally"); nothing sent.
   - `capability` present and self lacks it -> error toast; **no stanza sent**
     (hard client block).
   - Otherwise `await run()`; `{ ok: true, toast }` -> success toast (if any);
     `{ ok: false, error }` -> error toast.
5. Async server rejection of a command that passed local checks (e.g. server
   denies subject change) -> error toast via the normal SDK error channel.

The composer clears and refocuses only when a command was consumed (matching the
current `/christmas` behavior).

## Composer indicator

`MessageComposer` derives a `commandState` from the current text using a
classifier fed by the registry + context:

- `send` — `message`, `passthrough` (`/me`), or `literal` (`/say`, `//`).
- `command` — parses to a known, in-context, permitted command. Send button shows
  a distinct "run command" variant (icon + accent, tooltip from `usageKey`).
- `unknown` — leading slash that resolves to no command. Subtle warning variant;
  on submit it toasts the unknown-command hint rather than sending.

Classification runs in the existing `handleTextChange` (already per-keystroke), so
no new render pressure. Because the classifier needs context + capability, the
room context is assembled in RoomView (which already holds room, occupants, self
role, and the mention machinery) and the chat context is a lighter object (only
chat-valid commands). MessageComposer receives a `classifyInput(text)` callback
and the `aboveInput` menu node, keeping it context-agnostic.

## Integration notes

- **RoomConfigModal / InviteToRoomModal open-state** currently lives in
  RoomHeader / RoomView. `ui.openRoomConfig()` / `ui.openInviteModal()` set that
  state; the openers are wired where the modals are controlled (lift state to
  RoomView if needed).
- **Menu coexistence:** `@mention` (RoomView 1952-1993 render, 2055-2079 keydown)
  and the command menu both render via `aboveInput`. They are mutually exclusive
  by trigger (`@` mid-text vs `/` at position 0); the command menu takes the
  `aboveInput` slot only when active, and its keydown handler is gated on
  "command menu open" so the two never both consume Up/Down/Enter.
- **Chat vs room:** the completion menu is wired in RoomView for the core cut
  (most commands are room-only). 1:1 chat still gets the dispatcher + indicator
  for `/me`, `/say`, `/help`; a menu in the 1:1 composer can follow later.
- **`/nick` errors:** `joinRoom` sends presence; the conflict/`not-acceptable`
  error arrives asynchronously as a presence error. The plan must confirm the SDK
  surfaces that error to a place the command layer can turn into a toast; if not,
  a small SDK addition (resolve/reject on the join presence result) is in scope.

## Testing

- `parseSlashInput` — pure unit tests: `//`, `/say`, `/me `, `/me` (no space),
  `/nick bob`, leading/trailing whitespace, empty, plain message.
- `runCommand` — per-command unit tests with mocked `CommandContext` SDK + `ui`;
  assert the right SDK/ui call and `CommandResult`.
- Gating — non-moderator `/kick`, non-admin `/ban`, non-owner `/config` blocked
  with no SDK call; visibility filter for menu/help.
- Classifier — `send`/`command`/`unknown` states, `/me` and `/say` excluded.
- Completion filter — prefix, context, capability visibility.
- i18n — new keys under `commands.*` present in all 33 locales (`i18n.test.ts`).
  Genuine translations per repo policy (no placeholders, no em/en dashes).

## Out of scope (follow-up)

`/op`, `/deop`, `/voice`, `/mute`, `/whois`, `/ping`, `/clear`, `/destroy`,
`/away`/`/back`, `/msg`/`/query`; argument/nick completion; timeline system
messages; command menu in the 1:1 composer.
