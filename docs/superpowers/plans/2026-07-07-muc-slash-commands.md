# MUC Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an extensible slash-command system to the composer covering the core MUC commands (`/nick`, `/part`, `/topic`, `/kick`, `/ban`, `/invite`, `/config`) plus `/me`, `/say`, `/help`, with a completion menu, a help panel, and a send-button indicator that shows when input will run a command instead of being sent.

**Architecture:** A pure parser + a data-driven registry live in the app (`apps/fluux/src/commands/`). The SDK is untouched. Each view (RoomView, ChatView) assembles a `CommandContext` (SDK actions, self role/affiliation, UI openers, `resolveNick`, `t`) and hands a `resolveInput`/`classifyInput` pair down to a context-agnostic MessageComposer. Command feedback goes to `useToastStore`; `/help` opens a transient popover panel; `/config` and argless `/invite` open existing modals bridged through a small `roomUiStore`.

**Tech Stack:** React, TypeScript, Zustand, Vitest, react-i18next, lucide-react, Tailwind (fluux design tokens).

## Global Constraints

- User-facing strings: **no em-dashes (—) or en-dashes (–)**. Use plain punctuation.
- Every new i18n key must exist with a **genuine translation in all 33 locale files** under `apps/fluux/src/i18n/locales/`; `i18n.test.ts` enforces presence.
- No SDK type changes are needed; do **not** modify `packages/fluux-sdk`. (If a task appears to require it, stop and flag it.)
- Run app tests from `apps/fluux` (`cd apps/fluux && npx vitest run ...`); the repo-root config lacks the `@` alias.
- Before any completion claim: `npm run typecheck`, `npm test`, and lint must pass with no errors or stderr.
- Never include a Claude footer in commit messages.
- Branch: `feat/muc-slash-commands` (already checked out).

---

## File Structure

**Create:**
- `apps/fluux/src/commands/parseSlashInput.ts` — pure tokenizer.
- `apps/fluux/src/commands/parseSlashInput.test.ts`
- `apps/fluux/src/commands/types.ts` — `SlashCommand`, `CommandContext`, `CommandResult`, `ParsedInput`, `InputClass`.
- `apps/fluux/src/commands/capabilities.ts` — `hasCapability`.
- `apps/fluux/src/commands/capabilities.test.ts`
- `apps/fluux/src/commands/registry.ts` — `COMMANDS`, `findCommand`, `classifyInput`, `runCommand`, `splitTargetReason`.
- `apps/fluux/src/commands/registry.test.ts`
- `apps/fluux/src/stores/roomUiStore.ts` — modal open-state bridge.
- `apps/fluux/src/stores/roomUiStore.test.ts`
- `apps/fluux/src/hooks/useCommandMenu.ts` — completion-menu state.
- `apps/fluux/src/hooks/useCommandMenu.test.ts`
- `apps/fluux/src/components/composer/CommandMenu.tsx` — completion popover.
- `apps/fluux/src/components/composer/CommandMenu.test.tsx`
- `apps/fluux/src/components/composer/CommandHelpPanel.tsx` — `/help` panel.
- `apps/fluux/src/components/composer/CommandHelpPanel.test.tsx`
- `apps/fluux/src/hooks/useRoomCommandContext.ts` — assembles the room `CommandContext`.

**Modify:**
- `apps/fluux/src/hooks/useSlashCommands.ts` — rewrite into a registry-driven dispatcher.
- `apps/fluux/src/hooks/useSlashCommands.test.tsx` — rewrite.
- `apps/fluux/src/components/MessageComposer.tsx` — accept `resolveInput`/`classifyInput`, add the send-button indicator.
- `apps/fluux/src/components/RoomHeader.tsx` — read modal open-state from `roomUiStore`.
- `apps/fluux/src/components/RoomView.tsx` — wire context, dispatcher, command menu, help panel.
- `apps/fluux/src/components/ChatView.tsx` — wire context, dispatcher, help panel (no completion menu in this cut).
- All 33 files in `apps/fluux/src/i18n/locales/*.json` — add `commands.*` keys.

---

## Task 1: Pure input parser

**Files:**
- Create: `apps/fluux/src/commands/parseSlashInput.ts`
- Test: `apps/fluux/src/commands/parseSlashInput.test.ts`

**Interfaces:**
- Produces: `parseSlashInput(text: string): ParsedInput` where
  `ParsedInput = { kind: 'command'; name: string; args: string } | { kind: 'passthrough'; text: string } | { kind: 'literal'; text: string } | { kind: 'message' }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/commands/parseSlashInput.test.ts
import { describe, it, expect } from 'vitest'
import { parseSlashInput } from './parseSlashInput'

describe('parseSlashInput', () => {
  it('treats plain text as a message', () => {
    expect(parseSlashInput('hello world')).toEqual({ kind: 'message' })
  })
  it('treats // as a literal with one slash stripped', () => {
    expect(parseSlashInput('//not a command')).toEqual({ kind: 'literal', text: '/not a command' })
  })
  it('treats /me <action> as passthrough (verbatim)', () => {
    expect(parseSlashInput('/me waves hello')).toEqual({ kind: 'passthrough', text: '/me waves hello' })
  })
  it('treats /me without a trailing space as a command (no-op)', () => {
    expect(parseSlashInput('/me')).toEqual({ kind: 'command', name: 'me', args: '' })
  })
  it('treats /say <text> as a literal of the remainder', () => {
    expect(parseSlashInput('/say /me is literal')).toEqual({ kind: 'literal', text: '/me is literal' })
  })
  it('treats bare /say as an empty literal', () => {
    expect(parseSlashInput('/say')).toEqual({ kind: 'literal', text: '' })
  })
  it('parses a command name and args, lowercasing the name', () => {
    expect(parseSlashInput('/Nick Bob The Builder')).toEqual({ kind: 'command', name: 'nick', args: 'Bob The Builder' })
  })
  it('parses a command with no args', () => {
    expect(parseSlashInput('/part')).toEqual({ kind: 'command', name: 'part', args: '' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/commands/parseSlashInput.test.ts`
Expected: FAIL, cannot find module `./parseSlashInput`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/commands/parseSlashInput.ts
import type { ParsedInput } from './types'

/**
 * Classify raw composer text without consulting the command registry.
 * The registry decides whether a `command` name is known; this only tokenizes.
 */
export function parseSlashInput(text: string): ParsedInput {
  if (!text.startsWith('/')) return { kind: 'message' }
  // Escape hatch: "//foo" sends "/foo" literally.
  if (text.startsWith('//')) return { kind: 'literal', text: text.slice(1) }
  // "/me <action>" is sent verbatim (XEP-0245); requires the trailing space.
  if (text.startsWith('/me ')) return { kind: 'passthrough', text }
  // "/say <text>" sends <text> literally (lets a message start with a slash).
  if (text === '/say') return { kind: 'literal', text: '' }
  if (text.startsWith('/say ')) return { kind: 'literal', text: text.slice(5) }
  // General "/name args".
  const rest = text.slice(1)
  const spaceIdx = rest.search(/\s/)
  const name = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1)
  return { kind: 'command', name, args }
}
```

Also create the shared types file so the import resolves:

```ts
// apps/fluux/src/commands/types.ts
import type { RoomRole, RoomAffiliation } from '@fluux/sdk'

export type CommandCapability = 'moderator' | 'admin' | 'owner'
export type CommandContextKind = 'chat' | 'room'
export type InputClass = 'send' | 'command' | 'unknown'

export type ParsedInput =
  | { kind: 'command'; name: string; args: string }
  | { kind: 'passthrough'; text: string }
  | { kind: 'literal'; text: string }
  | { kind: 'message' }

export interface CommandSelf {
  role: RoomRole
  affiliation: RoomAffiliation
}

export interface CommandSdk {
  joinRoom(jid: string, nick: string): Promise<void>
  joinResult(jid: string): Promise<void>
  leaveRoom(jid: string): Promise<void>
  setSubject(jid: string, subject: string): Promise<void>
  setRole(jid: string, nick: string, role: RoomRole, reason?: string): Promise<void>
  setAffiliation(jid: string, userJid: string, aff: RoomAffiliation, reason?: string): Promise<void>
  invite(jid: string, inviteeJid: string, reason?: string): Promise<void>
}

export interface CommandUi {
  openInviteModal(): void
  openRoomConfig(): void
  openHelp(): void
}

export interface CommandApp {
  sendEasterEgg(animation: string): Promise<void> | void
}

export interface CommandContext {
  kind: CommandContextKind
  entityJid: string
  self?: CommandSelf
  currentSubject?: string
  sdk: CommandSdk
  ui: CommandUi
  app: CommandApp
  resolveNick(nick: string): string | undefined
  t: (key: string, opts?: Record<string, unknown>) => string
}

export type CommandResult = { ok: true; toast?: string } | { ok: false; error: string }

export interface SlashCommand {
  name: string
  aliases?: string[]
  descriptionKey: string
  usageKey?: string
  contexts: CommandContextKind[]
  capability?: CommandCapability
  run(ctx: CommandContext, args: string): Promise<CommandResult>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/commands/parseSlashInput.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/commands/parseSlashInput.ts apps/fluux/src/commands/parseSlashInput.test.ts apps/fluux/src/commands/types.ts
git commit -m "feat(commands): pure slash-input parser and shared types"
```

---

## Task 2: Capability gating helper

**Files:**
- Create: `apps/fluux/src/commands/capabilities.ts`
- Test: `apps/fluux/src/commands/capabilities.test.ts`

**Interfaces:**
- Consumes: `CommandCapability`, `CommandSelf` from `./types`.
- Produces: `hasCapability(cap: CommandCapability | undefined, self?: CommandSelf): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/commands/capabilities.test.ts
import { describe, it, expect } from 'vitest'
import { hasCapability } from './capabilities'

describe('hasCapability', () => {
  it('allows any command with no capability requirement', () => {
    expect(hasCapability(undefined, undefined)).toBe(true)
  })
  it('denies a gated command when self is unknown', () => {
    expect(hasCapability('moderator', undefined)).toBe(false)
  })
  it('moderator requires the moderator role', () => {
    expect(hasCapability('moderator', { role: 'moderator', affiliation: 'none' })).toBe(true)
    expect(hasCapability('moderator', { role: 'participant', affiliation: 'none' })).toBe(false)
  })
  it('admin accepts admin or owner affiliation', () => {
    expect(hasCapability('admin', { role: 'participant', affiliation: 'admin' })).toBe(true)
    expect(hasCapability('admin', { role: 'participant', affiliation: 'owner' })).toBe(true)
    expect(hasCapability('admin', { role: 'moderator', affiliation: 'member' })).toBe(false)
  })
  it('owner requires the owner affiliation', () => {
    expect(hasCapability('owner', { role: 'moderator', affiliation: 'owner' })).toBe(true)
    expect(hasCapability('owner', { role: 'moderator', affiliation: 'admin' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/commands/capabilities.test.ts`
Expected: FAIL, cannot find module `./capabilities`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/commands/capabilities.ts
import type { CommandCapability, CommandSelf } from './types'

/** Best-effort client-side gate. The server remains authoritative on execution. */
export function hasCapability(cap: CommandCapability | undefined, self?: CommandSelf): boolean {
  if (!cap) return true
  if (!self) return false
  switch (cap) {
    case 'moderator':
      return self.role === 'moderator'
    case 'admin':
      return self.affiliation === 'admin' || self.affiliation === 'owner'
    case 'owner':
      return self.affiliation === 'owner'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/commands/capabilities.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/commands/capabilities.ts apps/fluux/src/commands/capabilities.test.ts
git commit -m "feat(commands): capability gating helper"
```

---

## Task 3: Registry, dispatch, and command definitions

**Files:**
- Create: `apps/fluux/src/commands/registry.ts`
- Test: `apps/fluux/src/commands/registry.test.ts`

**Interfaces:**
- Consumes: `parseSlashInput`, `hasCapability`, all `./types`.
- Produces:
  - `COMMANDS: SlashCommand[]`
  - `findCommand(name: string, kind: CommandContextKind): SlashCommand | undefined`
  - `classifyInput(text: string, kind: CommandContextKind): InputClass`
  - `runCommand(parsed: { kind: 'command'; name: string; args: string }, ctx: CommandContext): Promise<CommandResult>`
  - `splitTargetReason(args: string): { target: string; reason?: string }`
  - `visibleCommands(kind: CommandContextKind, self?: CommandSelf): SlashCommand[]`

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/commands/registry.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runCommand, classifyInput, findCommand, splitTargetReason, visibleCommands } from './registry'
import type { CommandContext } from './types'

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    kind: 'room',
    entityJid: 'room@conf.example.com',
    self: { role: 'moderator', affiliation: 'owner' },
    currentSubject: 'Old subject',
    sdk: {
      joinRoom: vi.fn().mockResolvedValue(undefined),
      joinResult: vi.fn().mockResolvedValue(undefined),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      setSubject: vi.fn().mockResolvedValue(undefined),
      setRole: vi.fn().mockResolvedValue(undefined),
      setAffiliation: vi.fn().mockResolvedValue(undefined),
      invite: vi.fn().mockResolvedValue(undefined),
    },
    ui: { openInviteModal: vi.fn(), openRoomConfig: vi.fn(), openHelp: vi.fn() },
    app: { sendEasterEgg: vi.fn() },
    resolveNick: (nick: string) => (nick === 'alice' ? 'alice@example.com' : undefined),
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
    ...overrides,
  }
}

describe('splitTargetReason', () => {
  it('splits the first token from the rest', () => {
    expect(splitTargetReason('alice being rude')).toEqual({ target: 'alice', reason: 'being rude' })
  })
  it('returns no reason when only a target is given', () => {
    expect(splitTargetReason('  alice  ')).toEqual({ target: 'alice' })
  })
})

describe('classifyInput', () => {
  it('classifies plain text as send', () => {
    expect(classifyInput('hello', 'room')).toBe('send')
  })
  it('classifies /me as send (passthrough)', () => {
    expect(classifyInput('/me waves', 'room')).toBe('send')
  })
  it('classifies a known in-context command as command', () => {
    expect(classifyInput('/kick alice', 'room')).toBe('command')
  })
  it('classifies a room-only command as unknown in chat', () => {
    expect(classifyInput('/kick alice', 'chat')).toBe('unknown')
  })
  it('classifies an unknown slash as unknown', () => {
    expect(classifyInput('/frobnicate', 'room')).toBe('unknown')
  })
})

describe('findCommand', () => {
  it('resolves aliases', () => {
    expect(findCommand('subject', 'room')?.name).toBe('topic')
    expect(findCommand('leave', 'room')?.name).toBe('part')
  })
  it('does not resolve out-of-context commands', () => {
    expect(findCommand('kick', 'chat')).toBeUndefined()
  })
})

describe('visibleCommands', () => {
  it('hides capability-gated commands from users who lack the capability', () => {
    const names = visibleCommands('room', { role: 'participant', affiliation: 'none' }).map((c) => c.name)
    expect(names).not.toContain('kick')
    expect(names).not.toContain('ban')
    expect(names).not.toContain('config')
    expect(names).toContain('nick')
  })
})

describe('runCommand', () => {
  it('rejects an unknown command', async () => {
    const ctx = makeCtx()
    const res = await runCommand({ kind: 'command', name: 'frob', args: '' }, ctx)
    expect(res).toEqual({ ok: false, error: expect.stringContaining('commands.error.unknown') })
  })

  it('blocks /kick for a non-moderator without calling the SDK', async () => {
    const ctx = makeCtx({ self: { role: 'participant', affiliation: 'none' } })
    const res = await runCommand({ kind: 'command', name: 'kick', args: 'alice' }, ctx)
    expect(res).toEqual({ ok: false, error: 'commands.error.moderatorOnly' })
    expect(ctx.sdk.setRole).not.toHaveBeenCalled()
  })

  it('/kick sets role none with a reason', async () => {
    const ctx = makeCtx()
    const res = await runCommand({ kind: 'command', name: 'kick', args: 'alice spamming' }, ctx)
    expect(ctx.sdk.setRole).toHaveBeenCalledWith('room@conf.example.com', 'alice', 'none', 'spamming')
    expect(res.ok).toBe(true)
  })

  it('/ban resolves a nick to a JID and sets outcast', async () => {
    const ctx = makeCtx()
    await runCommand({ kind: 'command', name: 'ban', args: 'alice' }, ctx)
    expect(ctx.sdk.setAffiliation).toHaveBeenCalledWith('room@conf.example.com', 'alice@example.com', 'outcast', undefined)
  })

  it('/ban reports when a nick cannot be resolved', async () => {
    const ctx = makeCtx()
    const res = await runCommand({ kind: 'command', name: 'ban', args: 'ghost' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.sdk.setAffiliation).not.toHaveBeenCalled()
  })

  it('/nick rejoins and reports a conflict', async () => {
    const ctx = makeCtx()
    ;(ctx.sdk.joinResult as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ condition: 'conflict' })
    const res = await runCommand({ kind: 'command', name: 'nick', args: 'taken' }, ctx)
    expect(ctx.sdk.joinRoom).toHaveBeenCalledWith('room@conf.example.com', 'taken')
    expect(res).toEqual({ ok: false, error: expect.stringContaining('commands.error.nickInUse') })
  })

  it('/topic with no args reports the current subject', async () => {
    const ctx = makeCtx()
    const res = await runCommand({ kind: 'command', name: 'topic', args: '' }, ctx)
    expect(ctx.sdk.setSubject).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, toast: expect.stringContaining('commands.topic.current') })
  })

  it('/invite with no args opens the invite modal', async () => {
    const ctx = makeCtx()
    const res = await runCommand({ kind: 'command', name: 'invite', args: '' }, ctx)
    expect(ctx.ui.openInviteModal).toHaveBeenCalled()
    expect(res.ok).toBe(true)
  })

  it('/config opens the room config modal for an owner', async () => {
    const ctx = makeCtx()
    await runCommand({ kind: 'command', name: 'config', args: '' }, ctx)
    expect(ctx.ui.openRoomConfig).toHaveBeenCalled()
  })

  it('/help opens the help panel', async () => {
    const ctx = makeCtx()
    await runCommand({ kind: 'command', name: 'help', args: '' }, ctx)
    expect(ctx.ui.openHelp).toHaveBeenCalled()
  })

  it('/christmas fires the easter egg', async () => {
    const ctx = makeCtx()
    await runCommand({ kind: 'command', name: 'christmas', args: '' }, ctx)
    expect(ctx.app.sendEasterEgg).toHaveBeenCalledWith('christmas')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/commands/registry.test.ts`
Expected: FAIL, cannot find module `./registry`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/commands/registry.ts
import { parseSlashInput } from './parseSlashInput'
import { hasCapability } from './capabilities'
import type {
  CommandContext,
  CommandContextKind,
  CommandResult,
  CommandSelf,
  InputClass,
  ParsedInput,
  SlashCommand,
} from './types'

/** Split "alice being rude" into { target: 'alice', reason: 'being rude' }. */
export function splitTargetReason(args: string): { target: string; reason?: string } {
  const trimmed = args.trim()
  if (!trimmed) return { target: '' }
  const idx = trimmed.search(/\s/)
  if (idx === -1) return { target: trimmed }
  const reason = trimmed.slice(idx + 1).trim()
  return { target: trimmed.slice(0, idx), reason: reason || undefined }
}

/** Duck-typed read of a RoomJoinError-like rejection (avoids SDK-internal imports). */
function joinErrorCondition(e: unknown): string | undefined {
  return (e as { condition?: string } | null)?.condition
}

const me: SlashCommand = {
  name: 'me',
  descriptionKey: 'commands.me.desc',
  usageKey: 'commands.me.usage',
  contexts: ['chat', 'room'],
  // Real passthrough is handled by parseSlashInput; a bare "/me" is a no-op.
  run: async () => ({ ok: true }),
}

const say: SlashCommand = {
  name: 'say',
  descriptionKey: 'commands.say.desc',
  usageKey: 'commands.say.usage',
  contexts: ['chat', 'room'],
  // Literal send is handled by parseSlashInput; never dispatched here.
  run: async () => ({ ok: true }),
}

const help: SlashCommand = {
  name: 'help',
  aliases: ['?'],
  descriptionKey: 'commands.help.desc',
  usageKey: 'commands.help.usage',
  contexts: ['chat', 'room'],
  run: async (ctx) => {
    ctx.ui.openHelp()
    return { ok: true }
  },
}

const nick: SlashCommand = {
  name: 'nick',
  descriptionKey: 'commands.nick.desc',
  usageKey: 'commands.nick.usage',
  contexts: ['room'],
  run: async (ctx, args) => {
    const newNick = args.trim()
    if (!newNick) return { ok: false, error: ctx.t('commands.error.needNick') }
    try {
      await ctx.sdk.joinRoom(ctx.entityJid, newNick)
      await ctx.sdk.joinResult(ctx.entityJid)
      return { ok: true, toast: ctx.t('commands.nick.changed', { nick: newNick }) }
    } catch (e) {
      if (joinErrorCondition(e) === 'conflict') {
        return { ok: false, error: ctx.t('commands.error.nickInUse', { nick: newNick }) }
      }
      return { ok: false, error: ctx.t('commands.error.nickFailed') }
    }
  },
}

const part: SlashCommand = {
  name: 'part',
  aliases: ['leave'],
  descriptionKey: 'commands.part.desc',
  usageKey: 'commands.part.usage',
  contexts: ['room'],
  run: async (ctx) => {
    await ctx.sdk.leaveRoom(ctx.entityJid)
    return { ok: true }
  },
}

const topic: SlashCommand = {
  name: 'topic',
  aliases: ['subject'],
  descriptionKey: 'commands.topic.desc',
  usageKey: 'commands.topic.usage',
  contexts: ['room'],
  run: async (ctx, args) => {
    const next = args.trim()
    if (!next) {
      return {
        ok: true,
        toast: ctx.currentSubject
          ? ctx.t('commands.topic.current', { subject: ctx.currentSubject })
          : ctx.t('commands.topic.none'),
      }
    }
    await ctx.sdk.setSubject(ctx.entityJid, next)
    return { ok: true, toast: ctx.t('commands.topic.set') }
  },
}

const kick: SlashCommand = {
  name: 'kick',
  descriptionKey: 'commands.kick.desc',
  usageKey: 'commands.kick.usage',
  contexts: ['room'],
  capability: 'moderator',
  run: async (ctx, args) => {
    const { target, reason } = splitTargetReason(args)
    if (!target) return { ok: false, error: ctx.t('commands.error.needNick') }
    await ctx.sdk.setRole(ctx.entityJid, target, 'none', reason)
    return { ok: true, toast: ctx.t('commands.kick.done', { nick: target }) }
  },
}

const ban: SlashCommand = {
  name: 'ban',
  descriptionKey: 'commands.ban.desc',
  usageKey: 'commands.ban.usage',
  contexts: ['room'],
  capability: 'admin',
  run: async (ctx, args) => {
    const { target, reason } = splitTargetReason(args)
    if (!target) return { ok: false, error: ctx.t('commands.error.needTarget') }
    const jid = target.includes('@') ? target : ctx.resolveNick(target)
    if (!jid) return { ok: false, error: ctx.t('commands.error.userNotFound', { nick: target }) }
    await ctx.sdk.setAffiliation(ctx.entityJid, jid, 'outcast', reason)
    return { ok: true, toast: ctx.t('commands.ban.done', { target }) }
  },
}

const invite: SlashCommand = {
  name: 'invite',
  descriptionKey: 'commands.invite.desc',
  usageKey: 'commands.invite.usage',
  contexts: ['room'],
  run: async (ctx, args) => {
    const { target, reason } = splitTargetReason(args)
    if (!target) {
      ctx.ui.openInviteModal()
      return { ok: true }
    }
    const jid = target.includes('@') ? target : ctx.resolveNick(target)
    if (!jid) return { ok: false, error: ctx.t('commands.error.userNotFound', { nick: target }) }
    await ctx.sdk.invite(ctx.entityJid, jid, reason)
    return { ok: true, toast: ctx.t('commands.invite.done', { target: jid }) }
  },
}

const config: SlashCommand = {
  name: 'config',
  aliases: ['configure'],
  descriptionKey: 'commands.config.desc',
  usageKey: 'commands.config.usage',
  contexts: ['room'],
  capability: 'owner',
  run: async (ctx) => {
    ctx.ui.openRoomConfig()
    return { ok: true }
  },
}

const christmas: SlashCommand = {
  name: 'christmas',
  descriptionKey: 'commands.christmas.desc',
  contexts: ['chat', 'room'],
  run: async (ctx) => {
    await ctx.app.sendEasterEgg('christmas')
    return { ok: true }
  },
}

export const COMMANDS: SlashCommand[] = [
  me,
  say,
  help,
  nick,
  part,
  topic,
  kick,
  ban,
  invite,
  config,
  christmas,
]

export function findCommand(name: string, kind: CommandContextKind): SlashCommand | undefined {
  const cmd = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))
  if (!cmd || !cmd.contexts.includes(kind)) return undefined
  return cmd
}

/** Registry-visible commands for a context, hiding capability-gated ones the user lacks. */
export function visibleCommands(kind: CommandContextKind, self?: CommandSelf): SlashCommand[] {
  return COMMANDS.filter((c) => c.contexts.includes(kind) && hasCapability(c.capability, self))
}

/** How the send button should present the current input. Capability is enforced at run time. */
export function classifyInput(text: string, kind: CommandContextKind): InputClass {
  const parsed = parseSlashInput(text)
  if (parsed.kind !== 'command') return 'send'
  return findCommand(parsed.name, kind) ? 'command' : 'unknown'
}

export async function runCommand(
  parsed: Extract<ParsedInput, { kind: 'command' }>,
  ctx: CommandContext,
): Promise<CommandResult> {
  const cmd = findCommand(parsed.name, ctx.kind)
  if (!cmd) return { ok: false, error: ctx.t('commands.error.unknown', { name: parsed.name }) }
  if (!hasCapability(cmd.capability, ctx.self)) {
    const key = `commands.error.${cmd.capability}Only`
    return { ok: false, error: ctx.t(key) }
  }
  return cmd.run(ctx, parsed.args.trim())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/commands/registry.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/commands/registry.ts apps/fluux/src/commands/registry.test.ts
git commit -m "feat(commands): registry, dispatch, and core command definitions"
```

---

## Task 4: Room UI store (modal bridge)

**Files:**
- Create: `apps/fluux/src/stores/roomUiStore.ts`
- Test: `apps/fluux/src/stores/roomUiStore.test.ts`
- Modify: `apps/fluux/src/components/RoomHeader.tsx`

**Interfaces:**
- Produces: `useRoomUiStore` with state `{ configModalOpen: boolean; inviteModalOpen: boolean; openConfig(): void; closeConfig(): void; openInvite(): void; closeInvite(): void }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/stores/roomUiStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useRoomUiStore } from './roomUiStore'

describe('roomUiStore', () => {
  beforeEach(() => {
    useRoomUiStore.setState({ configModalOpen: false, inviteModalOpen: false })
  })
  it('opens and closes the config modal', () => {
    useRoomUiStore.getState().openConfig()
    expect(useRoomUiStore.getState().configModalOpen).toBe(true)
    useRoomUiStore.getState().closeConfig()
    expect(useRoomUiStore.getState().configModalOpen).toBe(false)
  })
  it('opens and closes the invite modal', () => {
    useRoomUiStore.getState().openInvite()
    expect(useRoomUiStore.getState().inviteModalOpen).toBe(true)
    useRoomUiStore.getState().closeInvite()
    expect(useRoomUiStore.getState().inviteModalOpen).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/stores/roomUiStore.test.ts`
Expected: FAIL, cannot find module `./roomUiStore`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/stores/roomUiStore.ts
import { create } from 'zustand'

interface RoomUiState {
  configModalOpen: boolean
  inviteModalOpen: boolean
  openConfig: () => void
  closeConfig: () => void
  openInvite: () => void
  closeInvite: () => void
}

/**
 * Bridges room-chrome modal open-state so slash commands (run in RoomView) can
 * open modals that are rendered in RoomHeader without threading props.
 */
export const useRoomUiStore = create<RoomUiState>((set) => ({
  configModalOpen: false,
  inviteModalOpen: false,
  openConfig: () => set({ configModalOpen: true }),
  closeConfig: () => set({ configModalOpen: false }),
  openInvite: () => set({ inviteModalOpen: true }),
  closeInvite: () => set({ inviteModalOpen: false }),
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/stores/roomUiStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire RoomHeader to the store**

In `apps/fluux/src/components/RoomHeader.tsx`, replace the two local `useState` flags (around lines 68-71) for the config and invite modals with the store. Keep `showAvatarModal`, `showMembersModal`, and any others as local state.

Remove:

```ts
const [showInviteModal, setShowInviteModal] = useState(false)
const [showConfigModal, setShowConfigModal] = useState(false)
```

Add near the top of the component body:

```ts
const configModalOpen = useRoomUiStore((s) => s.configModalOpen)
const inviteModalOpen = useRoomUiStore((s) => s.inviteModalOpen)
const openConfig = useRoomUiStore((s) => s.openConfig)
const closeConfig = useRoomUiStore((s) => s.closeConfig)
const openInvite = useRoomUiStore((s) => s.openInvite)
const closeInvite = useRoomUiStore((s) => s.closeInvite)
```

Add the import at the top:

```ts
import { useRoomUiStore } from '../stores/roomUiStore'
```

Then update the call sites:
- The management-group callbacks (around lines 90-96): `onConfig: () => setShowConfigModal(true)` becomes `onConfig: openConfig`; any `onInvite: () => setShowInviteModal(true)` becomes `onInvite: openInvite`.
- The render guards: `{showConfigModal && (<RoomConfigModal onClose={() => setShowConfigModal(false)} ... />)}` becomes `{configModalOpen && (<RoomConfigModal onClose={closeConfig} ... />)}`. Do the same for the invite modal: gate on `inviteModalOpen`, pass `isOpen={inviteModalOpen}` and `onClose={closeInvite}` per `InviteToRoomModalProps`.

- [ ] **Step 6: Verify the app still type-checks and RoomHeader tests (if any) pass**

Run: `cd apps/fluux && npx vitest run src/components/RoomHeader.test.tsx 2>/dev/null; cd /Users/mremond/AIProjects/fluux-messenger && npm run typecheck`
Expected: typecheck passes; RoomHeader tests (if present) pass. If there is no RoomHeader test file, the vitest call is a no-op.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/stores/roomUiStore.ts apps/fluux/src/stores/roomUiStore.test.ts apps/fluux/src/components/RoomHeader.tsx
git commit -m "feat(rooms): bridge config/invite modal state through roomUiStore"
```

---

## Task 5: Rewrite the dispatcher hook

**Files:**
- Modify: `apps/fluux/src/hooks/useSlashCommands.ts`
- Modify: `apps/fluux/src/hooks/useSlashCommands.test.tsx`

**Interfaces:**
- Consumes: `parseSlashInput`, `runCommand`, `classifyInput`, `CommandContext`, `InputClass`; `useToastStore` from `../stores/toastStore`.
- Produces: `useSlashCommands(context: CommandContext): { resolveInput(text: string): Promise<string | 'consumed'>; classifyInput(text: string): InputClass }`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/fluux/src/hooks/useSlashCommands.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSlashCommands } from './useSlashCommands'
import { useToastStore } from '../stores/toastStore'
import type { CommandContext } from '../commands/types'

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    kind: 'room',
    entityJid: 'room@conf.example.com',
    self: { role: 'moderator', affiliation: 'owner' },
    sdk: {
      joinRoom: vi.fn().mockResolvedValue(undefined),
      joinResult: vi.fn().mockResolvedValue(undefined),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      setSubject: vi.fn().mockResolvedValue(undefined),
      setRole: vi.fn().mockResolvedValue(undefined),
      setAffiliation: vi.fn().mockResolvedValue(undefined),
      invite: vi.fn().mockResolvedValue(undefined),
    },
    ui: { openInviteModal: vi.fn(), openRoomConfig: vi.fn(), openHelp: vi.fn() },
    app: { sendEasterEgg: vi.fn() },
    resolveNick: () => undefined,
    t: (k: string) => k,
    ...overrides,
  }
}

describe('useSlashCommands', () => {
  beforeEach(() => useToastStore.setState({ toasts: [] }))

  it('returns the original text for a plain message', async () => {
    const { result } = renderHook(() => useSlashCommands(ctx()))
    expect(await result.current.resolveInput('hello')).toBe('hello')
  })

  it('returns the verbatim text for /me', async () => {
    const { result } = renderHook(() => useSlashCommands(ctx()))
    expect(await result.current.resolveInput('/me waves')).toBe('/me waves')
  })

  it('returns the stripped literal for /say', async () => {
    const { result } = renderHook(() => useSlashCommands(ctx()))
    expect(await result.current.resolveInput('/say /literal')).toBe('/literal')
  })

  it('consumes a command and toasts its error', async () => {
    const c = ctx({ self: { role: 'participant', affiliation: 'none' } })
    const { result } = renderHook(() => useSlashCommands(c))
    expect(await result.current.resolveInput('/kick alice')).toBe('consumed')
    const toasts = useToastStore.getState().toasts
    expect(toasts[0]?.type).toBe('error')
    expect(c.sdk.setRole).not.toHaveBeenCalled()
  })

  it('consumes a command and toasts a success message', async () => {
    const c = ctx()
    const { result } = renderHook(() => useSlashCommands(c))
    expect(await result.current.resolveInput('/kick alice rude')).toBe('consumed')
    expect(useToastStore.getState().toasts[0]?.type).toBe('success')
  })

  it('classifies input for the indicator', () => {
    const { result } = renderHook(() => useSlashCommands(ctx()))
    expect(result.current.classifyInput('/kick alice')).toBe('command')
    expect(result.current.classifyInput('hello')).toBe('send')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useSlashCommands.test.tsx`
Expected: FAIL (old hook signature / new expectations mismatch).

- [ ] **Step 3: Write the implementation**

```ts
// apps/fluux/src/hooks/useSlashCommands.ts
import { useCallback } from 'react'
import { parseSlashInput } from '../commands/parseSlashInput'
import { runCommand, classifyInput as classify } from '../commands/registry'
import type { CommandContext, InputClass } from '../commands/types'
import { useToastStore } from '../stores/toastStore'

/**
 * Registry-driven slash-command dispatcher.
 *
 * `resolveInput` returns the text that should actually be sent, or the sentinel
 * `'consumed'` when the input was a command (feedback is delivered via toast).
 * `classifyInput` drives the composer's send-button indicator.
 */
export function useSlashCommands(context: CommandContext) {
  const addToast = useToastStore((s) => s.addToast)

  const resolveInput = useCallback(
    async (text: string): Promise<string | 'consumed'> => {
      const parsed = parseSlashInput(text)
      if (parsed.kind === 'message') return text
      if (parsed.kind === 'passthrough') return parsed.text
      if (parsed.kind === 'literal') return parsed.text
      const result = await runCommand(parsed, context)
      if (result.ok) {
        if (result.toast) addToast('success', result.toast)
      } else {
        addToast('error', result.error)
      }
      return 'consumed'
    },
    [context, addToast],
  )

  const classifyInput = useCallback(
    (text: string): InputClass => classify(text, context.kind),
    [context.kind],
  )

  return { resolveInput, classifyInput }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useSlashCommands.test.tsx`
Expected: PASS (6 tests). (MessageComposer will not type-check yet; that is Task 7.)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/useSlashCommands.ts apps/fluux/src/hooks/useSlashCommands.test.tsx
git commit -m "feat(commands): registry-driven dispatcher hook"
```

---

## Task 6: Completion-menu state hook

**Files:**
- Create: `apps/fluux/src/hooks/useCommandMenu.ts`
- Test: `apps/fluux/src/hooks/useCommandMenu.test.ts`

**Interfaces:**
- Consumes: `visibleCommands` from `../commands/registry`; `CommandContextKind`, `CommandSelf`, `SlashCommand` from `../commands/types`.
- Produces: `useCommandMenu(text: string, cursor: number, kind: CommandContextKind, self?: CommandSelf)` returning
  `{ state: { isActive: boolean; matches: SlashCommand[]; selectedIndex: number }; moveSelection(dir: 'up' | 'down'): void; dismiss(): void; reset(): void }`
  and the pure helper `matchCommandMenu(text, cursor, kind, self): { isActive: boolean; matches: SlashCommand[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/hooks/useCommandMenu.test.ts
import { describe, it, expect } from 'vitest'
import { matchCommandMenu } from './useCommandMenu'

describe('matchCommandMenu', () => {
  it('is inactive for non-command text', () => {
    expect(matchCommandMenu('hello', 5, 'room').isActive).toBe(false)
  })
  it('is inactive once a space is typed (name is complete)', () => {
    expect(matchCommandMenu('/kick alice', 11, 'room').isActive).toBe(false)
  })
  it('activates on a bare partial command at position 0', () => {
    const m = matchCommandMenu('/ki', 3, 'room')
    expect(m.isActive).toBe(true)
    expect(m.matches.map((c) => c.name)).toContain('kick')
  })
  it('lists all context commands for a lone slash', () => {
    const m = matchCommandMenu('/', 1, 'room')
    expect(m.isActive).toBe(true)
    expect(m.matches.length).toBeGreaterThan(1)
  })
  it('matches aliases', () => {
    const m = matchCommandMenu('/lea', 4, 'room')
    expect(m.matches.map((c) => c.name)).toContain('part')
  })
  it('hides capability-gated commands the user lacks', () => {
    const m = matchCommandMenu('/', 1, 'room', { role: 'participant', affiliation: 'none' })
    expect(m.matches.map((c) => c.name)).not.toContain('kick')
  })
  it('does not activate when the cursor is not at the end of the token', () => {
    // caret at index 1 (right after the slash) while text has more chars typed later
    expect(matchCommandMenu('/kick', 0, 'room').isActive).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useCommandMenu.test.ts`
Expected: FAIL, cannot find module `./useCommandMenu`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/hooks/useCommandMenu.ts
import { useEffect, useMemo, useState } from 'react'
import { visibleCommands } from '../commands/registry'
import type { CommandContextKind, CommandSelf, SlashCommand } from '../commands/types'

const PARTIAL = /^\/(\w*)$/

/** Pure: is the composer showing a bare partial command, and which commands match? */
export function matchCommandMenu(
  text: string,
  cursor: number,
  kind: CommandContextKind,
  self?: CommandSelf,
): { isActive: boolean; matches: SlashCommand[] } {
  // Only active when the whole input up to the caret is "/" + word, caret at end.
  if (cursor !== text.length) return { isActive: false, matches: [] }
  const m = text.match(PARTIAL)
  if (!m) return { isActive: false, matches: [] }
  const partial = m[1].toLowerCase()
  const matches = visibleCommands(kind, self).filter(
    (c) => c.name.startsWith(partial) || c.aliases?.some((a) => a.startsWith(partial)),
  )
  return { isActive: matches.length > 0, matches }
}

export function useCommandMenu(
  text: string,
  cursor: number,
  kind: CommandContextKind,
  self?: CommandSelf,
) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const { isActive, matches } = useMemo(
    () => matchCommandMenu(text, cursor, kind, self),
    [text, cursor, kind, self],
  )

  // Reset the dismissal + selection whenever the token changes.
  useEffect(() => {
    setSelectedIndex(0)
    setDismissed(false)
  }, [text])

  const active = isActive && !dismissed

  return {
    state: { isActive: active, matches, selectedIndex: Math.min(selectedIndex, Math.max(0, matches.length - 1)) },
    moveSelection: (dir: 'up' | 'down') =>
      setSelectedIndex((i) => {
        const n = matches.length
        if (n === 0) return 0
        return dir === 'down' ? (i + 1) % n : (i - 1 + n) % n
      }),
    dismiss: () => setDismissed(true),
    reset: () => {
      setSelectedIndex(0)
      setDismissed(false)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useCommandMenu.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/useCommandMenu.ts apps/fluux/src/hooks/useCommandMenu.test.ts
git commit -m "feat(commands): completion-menu state hook"
```

---

## Task 7: MessageComposer — dispatcher wiring and send-button indicator

**Files:**
- Modify: `apps/fluux/src/components/MessageComposer.tsx`

**Interfaces:**
- Consumes: `useSlashCommands` output shape via props `resolveInput?: (text: string) => Promise<string | 'consumed'>` and `classifyInput?: (text: string) => InputClass`.
- Produces: unchanged public send behavior for callers that pass neither prop.

Context: `MessageComposer` currently calls `useSlashCommands({ sendEasterEgg })` internally and uses `handleCommand` in `handleSubmit` (around line 493). We remove that internal call and drive commands through the new props supplied by the view.

- [ ] **Step 1: Add the new props to the interface**

In the `MessageComposerProps` interface, add:

```ts
  /** Resolve slash-command input. Returns the text to send, or 'consumed' when a command ran. */
  resolveInput?: (text: string) => Promise<string | 'consumed'>
  /** Classify current input for the send-button indicator. */
  classifyInput?: (text: string) => InputClass
```

Add the import near the other type imports:

```ts
import type { InputClass } from '../commands/types'
```

Destructure `resolveInput` and `classifyInput` from props alongside the existing ones.

- [ ] **Step 2: Remove the old internal command hook**

Delete the internal `const { handleCommand } = useSlashCommands(...)` call and its `import { useSlashCommands } ...` line in this file (the dispatcher now lives in the view). Leave the `onSendEasterEgg` prop in place for any non-command callers.

- [ ] **Step 3: Rewrite the command branch in `handleSubmit`**

Replace the block at line 493:

```ts
  // Handle slash commands (but not when editing)
  if (!editingMessage && trimmed && await handleCommand(trimmed)) {
    setText('')
    inputRef.current?.focus()
    return
  }
```

with:

```ts
  // Slash commands (never while editing). resolveInput returns the text to send,
  // or 'consumed' when the input triggered a command.
  let outgoingText = trimmed
  if (!editingMessage && trimmed && resolveInput) {
    const outcome = await resolveInput(trimmed)
    if (outcome === 'consumed') {
      setText('')
      inputRef.current?.focus()
      return
    }
    outgoingText = outcome
  }
```

Then, in the normal send path below, change the message body passed to `onSend` from `trimmed` to `outgoingText` (the `onSend(trimmed)` call around line 527). Leave edit/correction and attachment paths untouched (they do not go through `resolveInput`).

- [ ] **Step 4: Add the indicator state and update it on change**

Add near the other `useState` calls:

```ts
const [inputClass, setInputClass] = useState<InputClass>('send')
```

In `handleTextChange`, right after `setText(e.target.value)`, add:

```ts
setInputClass(classifyInput ? classifyInput(e.target.value) : 'send')
```

- [ ] **Step 5: Reflect the indicator on the send button**

Locate the send/submit button in the returned JSX. Add an import for a command icon:

```ts
import { Terminal } from 'lucide-react'
```

Render its icon and accent conditionally. Where the button currently renders the send icon, use:

```tsx
{inputClass === 'command' ? (
  <Terminal className="size-5" aria-hidden />
) : (
  /* existing send icon */
)}
```

Add a title/aria-label and accent class driven by `inputClass`:

```tsx
title={
  inputClass === 'command'
    ? t('commands.indicator.willRun')
    : inputClass === 'unknown'
      ? t('commands.indicator.unknownHint')
      : undefined
}
className={`${/* existing button classes */ ''} ${
  inputClass === 'command'
    ? 'text-fluux-brand'
    : inputClass === 'unknown'
      ? 'text-fluux-warning'
      : ''
}`}
```

(Use the existing send-button element and merge these into its current `className`/attributes rather than adding a second element. If `text-fluux-warning` is not a defined token, use `text-fluux-muted`.)

- [ ] **Step 6: Typecheck**

Run: `cd /Users/mremond/AIProjects/fluux-messenger && npm run typecheck`
Expected: PASS. (Views not yet passing the new props still compile because the props are optional.)

- [ ] **Step 7: Run the composer tests**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.test.tsx 2>/dev/null || true`
Expected: existing tests pass (or no test file). If a test asserted the old easter-egg-through-`handleCommand` path, update it to pass a `resolveInput` stub.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/MessageComposer.test.tsx
git commit -m "feat(composer): drive slash commands via props and add command indicator"
```

---

## Task 8: CommandMenu and CommandHelpPanel components

**Files:**
- Create: `apps/fluux/src/components/composer/CommandMenu.tsx`
- Test: `apps/fluux/src/components/composer/CommandMenu.test.tsx`
- Create: `apps/fluux/src/components/composer/CommandHelpPanel.tsx`
- Test: `apps/fluux/src/components/composer/CommandHelpPanel.test.tsx`

**Interfaces:**
- Produces:
  - `<CommandMenu matches={SlashCommand[]} selectedIndex={number} onSelect={(index: number) => void} />`
  - `<CommandHelpPanel commands={SlashCommand[]} onClose={() => void} />`

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/fluux/src/components/composer/CommandMenu.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommandMenu } from './CommandMenu'
import { COMMANDS } from '../../commands/registry'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

describe('CommandMenu', () => {
  const kick = COMMANDS.find((c) => c.name === 'kick')!
  const nick = COMMANDS.find((c) => c.name === 'nick')!

  it('renders one row per match with the command name', () => {
    render(<CommandMenu matches={[kick, nick]} selectedIndex={0} onSelect={() => {}} />)
    expect(screen.getByText('/kick')).toBeInTheDocument()
    expect(screen.getByText('/nick')).toBeInTheDocument()
  })
  it('fires onSelect with the clicked index', () => {
    const onSelect = vi.fn()
    render(<CommandMenu matches={[kick, nick]} selectedIndex={0} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('/nick'))
    expect(onSelect).toHaveBeenCalledWith(1)
  })
})
```

```tsx
// apps/fluux/src/components/composer/CommandHelpPanel.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommandHelpPanel } from './CommandHelpPanel'
import { COMMANDS } from '../../commands/registry'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

describe('CommandHelpPanel', () => {
  it('lists each command usage and calls onClose', () => {
    const onClose = vi.fn()
    render(<CommandHelpPanel commands={COMMANDS.slice(0, 3)} onClose={onClose} />)
    expect(screen.getByText('commands.help.title')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('common.close'))
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/composer/CommandMenu.test.tsx src/components/composer/CommandHelpPanel.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the components**

```tsx
// apps/fluux/src/components/composer/CommandMenu.tsx
import { useTranslation } from 'react-i18next'
import type { SlashCommand } from '../../commands/types'

interface CommandMenuProps {
  matches: SlashCommand[]
  selectedIndex: number
  onSelect: (index: number) => void
}

/** Command-name completion popover, rendered through MessageComposer's `aboveInput` slot. */
export function CommandMenu({ matches, selectedIndex, onSelect }: CommandMenuProps) {
  const { t } = useTranslation()
  if (matches.length === 0) return null
  return (
    <div className="absolute bottom-full inset-x-0 mb-1 max-h-48 overflow-y-auto fluux-popover rounded-lg z-30">
      {matches.map((cmd, idx) => (
        <button
          key={cmd.name}
          type="button"
          onClick={() => onSelect(idx)}
          className={`w-full px-3 py-2 text-start text-sm flex items-baseline gap-2 transition-colors ${
            idx === selectedIndex
              ? 'bg-fluux-brand text-fluux-text-on-accent'
              : 'hover:bg-fluux-hover text-fluux-text'
          }`}
        >
          <span className="font-medium">/{cmd.name}</span>
          <span
            className={`text-xs ${
              idx === selectedIndex ? 'text-fluux-text-on-accent/70' : 'text-fluux-muted'
            }`}
          >
            {t(cmd.descriptionKey)}
          </span>
        </button>
      ))}
    </div>
  )
}
```

```tsx
// apps/fluux/src/components/composer/CommandHelpPanel.tsx
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { SlashCommand } from '../../commands/types'

interface CommandHelpPanelProps {
  commands: SlashCommand[]
  onClose: () => void
}

/** Transient panel listing available commands. Rendered through `aboveInput`. */
export function CommandHelpPanel({ commands, onClose }: CommandHelpPanelProps) {
  const { t } = useTranslation()
  return (
    <div className="absolute bottom-full inset-x-0 mb-1 max-h-64 overflow-y-auto fluux-popover rounded-lg z-30 p-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-sm font-semibold text-fluux-text">{t('commands.help.title')}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="p-1 rounded hover:bg-fluux-hover text-fluux-muted"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <ul>
        {commands.map((cmd) => (
          <li key={cmd.name} className="px-1 py-1">
            <span className="text-sm font-medium text-fluux-text">
              {cmd.usageKey ? t(cmd.usageKey) : `/${cmd.name}`}
            </span>
            <span className="block text-xs text-fluux-muted">{t(cmd.descriptionKey)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/composer/CommandMenu.test.tsx src/components/composer/CommandHelpPanel.test.tsx`
Expected: PASS. (If `common.close` is not the existing close-label key, use whatever key the repo already uses for modal close buttons and adjust the test.)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/composer/CommandMenu.tsx apps/fluux/src/components/composer/CommandMenu.test.tsx apps/fluux/src/components/composer/CommandHelpPanel.tsx apps/fluux/src/components/composer/CommandHelpPanel.test.tsx
git commit -m "feat(composer): command completion menu and help panel components"
```

---

## Task 9: Room command context + RoomView wiring

**Files:**
- Create: `apps/fluux/src/hooks/useRoomCommandContext.ts`
- Modify: `apps/fluux/src/components/RoomView.tsx`

**Interfaces:**
- Consumes: `useRoomActions`, `useRoomModeration`, `useRoomManagement` from `@fluux/sdk`; `useRoomUiStore`; `CommandContext`.
- Produces: `useRoomCommandContext(args): CommandContext` where `args = { roomJid: string; self: CommandSelf; occupants: Map<string, { jid?: string }>; currentSubject?: string; onOpenHelp: () => void; sendEasterEgg: (roomJid: string, kind: 'room', animation: string) => void }`.

- [ ] **Step 1: Write the context hook**

```ts
// apps/fluux/src/hooks/useRoomCommandContext.ts
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useRoomActions, useRoomModeration, useRoomManagement } from '@fluux/sdk'
import { useRoomUiStore } from '../stores/roomUiStore'
import type { CommandContext, CommandSelf } from '../commands/types'

interface RoomCommandContextArgs {
  roomJid: string
  self: CommandSelf
  occupants: Map<string, { jid?: string }>
  currentSubject?: string
  onOpenHelp: () => void
  sendEasterEgg: (roomJid: string, kind: 'room', animation: string) => void
}

/** Assemble the room-scoped CommandContext consumed by the dispatcher. */
export function useRoomCommandContext(args: RoomCommandContextArgs): CommandContext {
  const { roomJid, self, occupants, currentSubject, onOpenHelp, sendEasterEgg } = args
  const { t } = useTranslation()
  const { joinRoom, joinResult, leaveRoom } = useRoomActions()
  const { setRole, setAffiliation } = useRoomModeration()
  const { setSubject, inviteToRoom } = useRoomManagement()
  const openInvite = useRoomUiStore((s) => s.openInvite)
  const openConfig = useRoomUiStore((s) => s.openConfig)

  return useMemo<CommandContext>(
    () => ({
      kind: 'room',
      entityJid: roomJid,
      self,
      currentSubject,
      sdk: {
        joinRoom: (jid, nick) => joinRoom(jid, nick),
        joinResult: (jid) => joinResult(jid),
        leaveRoom: (jid) => leaveRoom(jid),
        setSubject: (jid, subject) => setSubject(jid, subject),
        setRole: (jid, nick, role, reason) => setRole(jid, nick, role, reason),
        setAffiliation: (jid, userJid, aff, reason) => setAffiliation(jid, userJid, aff, reason),
        invite: (jid, inviteeJid, reason) => inviteToRoom(jid, inviteeJid, reason),
      },
      ui: { openInviteModal: openInvite, openRoomConfig: openConfig, openHelp: onOpenHelp },
      app: { sendEasterEgg: (animation) => sendEasterEgg(roomJid, 'room', animation) },
      resolveNick: (nick) => occupants.get(nick)?.jid,
      t,
    }),
    [
      roomJid, self, currentSubject, occupants, onOpenHelp, sendEasterEgg,
      joinRoom, joinResult, leaveRoom, setSubject, setRole, setAffiliation, inviteToRoom,
      openInvite, openConfig, t,
    ],
  )
}
```

Note: `useRoomActions` must expose `joinResult`. Confirm it is re-exported by that hook; if only `client.muc.joinResult` exists, add `joinResult` to the hook's returned object in `packages/fluux-sdk/src/hooks/useRoomActions.ts` (a hook addition, not a protocol/type change) — mirror the existing `joinRoom` wrapper. If this proves to require SDK type surface changes, stop and flag it per Global Constraints.

- [ ] **Step 2: Wire the context, dispatcher, and menus into RoomView**

In `apps/fluux/src/components/RoomView.tsx`:

Add imports:

```ts
import { useRoomCommandContext } from '../hooks/useRoomCommandContext'
import { useSlashCommands } from '../hooks/useSlashCommands'
import { useCommandMenu } from '../hooks/useCommandMenu'
import { CommandMenu } from './composer/CommandMenu'
import { CommandHelpPanel } from './composer/CommandHelpPanel'
import { visibleCommands } from '../commands/registry'
```

Add help-panel state and derive self:

```ts
const [helpOpen, setHelpOpen] = useState(false)
const selfOccupant = activeRoom?.occupants.get(activeRoom.nickname)
const commandSelf = {
  role: selfOccupant?.role ?? 'none',
  affiliation: selfOccupant?.affiliation ?? 'none',
}
```

Build the context and dispatcher (place after `occupants` and `roomNickname` are available; `activeRoom.subject` provides the current subject — use the field the store actually exposes for the room subject):

```ts
const commandContext = useRoomCommandContext({
  roomJid: roomJif,
  self: commandSelf,
  occupants,
  currentSubject: activeRoom?.subject,
  onOpenHelp: () => setHelpOpen(true),
  sendEasterEgg, // existing easter-egg sender already used by this view
})
const { resolveInput, classifyInput } = useSlashCommands(commandContext)
const commandMenu = useCommandMenu(text, cursorPosition, 'room', commandSelf)
```

- [ ] **Step 3: Coexist with the mention menu in the keydown handler**

The mention keydown block is at lines ~2055-2079. Add a command-menu block **before** it so that, when the command menu is active, it owns the arrow/enter/escape keys (the two are mutually exclusive by trigger, but this makes precedence explicit):

```ts
if (commandMenu.state.isActive) {
  if (e.key === 'ArrowUp') { e.preventDefault(); commandMenu.moveSelection('up'); return }
  if (e.key === 'ArrowDown') { e.preventDefault(); commandMenu.moveSelection('down'); return }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    const cmd = commandMenu.state.matches[commandMenu.state.selectedIndex]
    if (cmd) { setText(`/${cmd.name} `); commandMenu.dismiss() }
    return
  }
  if (e.key === 'Escape') { e.preventDefault(); commandMenu.dismiss(); return }
}
```

- [ ] **Step 4: Render the popovers through `aboveInput` with priority**

Build a combined node (help panel wins, then command menu, then the existing `mentionDropdown`):

```tsx
const aboveInputNode = helpOpen ? (
  <CommandHelpPanel commands={visibleCommands('room', commandSelf)} onClose={() => setHelpOpen(false)} />
) : commandMenu.state.isActive ? (
  <CommandMenu
    matches={commandMenu.state.matches}
    selectedIndex={commandMenu.state.selectedIndex}
    onSelect={(idx) => {
      const cmd = commandMenu.state.matches[idx]
      if (cmd) { setText(`/${cmd.name} `); commandMenu.dismiss() }
    }}
  />
) : (
  mentionDropdown
)
```

Change the `MessageComposer` usage (line ~2189) from `aboveInput={mentionDropdown}` to `aboveInput={aboveInputNode}`, and pass the new props:

```tsx
resolveInput={resolveInput}
classifyInput={classifyInput}
```

- [ ] **Step 5: Typecheck and run the room test suite**

Run: `cd /Users/mremond/AIProjects/fluux-messenger && npm run typecheck && cd apps/fluux && npx vitest run src/components/RoomView.test.tsx 2>/dev/null || true`
Expected: typecheck PASS; RoomView tests pass (or none present). If `activeRoom.subject` is not the correct field name for the subject, use the store's actual field (check the `Room` type) and fix the reference.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useRoomCommandContext.ts apps/fluux/src/components/RoomView.tsx packages/fluux-sdk/src/hooks/useRoomActions.ts
git commit -m "feat(rooms): wire slash-command dispatcher, completion menu, and help panel into RoomView"
```

(Only include the SDK file if Step 1 required adding `joinResult` to the hook.)

---

## Task 10: ChatView wiring (1:1)

**Files:**
- Modify: `apps/fluux/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `useSlashCommands`, `visibleCommands`, `CommandHelpPanel`, `CommandContext`.
- Produces: 1:1 composer that supports `/me`, `/say`, `/help`, `/christmas` and the send-button indicator. No completion menu in this cut.

- [ ] **Step 1: Build a minimal chat context and dispatcher**

In `apps/fluux/src/components/ChatView.tsx`, add imports:

```ts
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSlashCommands } from '../hooks/useSlashCommands'
import { visibleCommands } from '../commands/registry'
import { CommandHelpPanel } from './composer/CommandHelpPanel'
import type { CommandContext } from '../commands/types'
```

Add help state and a chat context (room SDK methods are never reached in chat context, so they throw defensively):

```ts
const { t } = useTranslation()
const [helpOpen, setHelpOpen] = useState(false)

const notInRoom = async () => { throw new Error('not available in a 1:1 chat') }
const chatContext = useMemo<CommandContext>(() => ({
  kind: 'chat',
  entityJid: conversationId, // the 1:1 conversation JID used by this view
  sdk: {
    joinRoom: notInRoom, joinResult: notInRoom, leaveRoom: notInRoom,
    setSubject: notInRoom, setRole: notInRoom, setAffiliation: notInRoom, invite: notInRoom,
  },
  ui: {
    openInviteModal: () => {}, openRoomConfig: () => {}, openHelp: () => setHelpOpen(true),
  },
  app: { sendEasterEgg: (animation) => sendEasterEgg(conversationId, 'chat', animation) },
  resolveNick: () => undefined,
  t,
}), [conversationId, t])

const { resolveInput, classifyInput } = useSlashCommands(chatContext)
```

(Use this view's actual conversation-id variable and its existing `sendEasterEgg` sender; the names above mirror the SDK hook example.)

- [ ] **Step 2: Pass props and the help panel to MessageComposer**

On this view's `<MessageComposer .../>`, add:

```tsx
resolveInput={resolveInput}
classifyInput={classifyInput}
aboveInput={helpOpen ? (
  <CommandHelpPanel commands={visibleCommands('chat')} onClose={() => setHelpOpen(false)} />
) : undefined}
```

- [ ] **Step 3: Typecheck and run the chat test suite**

Run: `cd /Users/mremond/AIProjects/fluux-messenger && npm run typecheck && cd apps/fluux && npx vitest run src/components/ChatView.test.tsx 2>/dev/null || true`
Expected: typecheck PASS; chat tests pass (or none present).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/ChatView.tsx
git commit -m "feat(chat): wire slash-command dispatcher and help panel into 1:1 view"
```

---

## Task 11: i18n keys across all locales

**Files:**
- Modify: all 33 files in `apps/fluux/src/i18n/locales/*.json`

**Interfaces:**
- Produces: a `commands` namespace with the keys listed below in every locale.

- [ ] **Step 1: Add the English source keys**

Add this block to `apps/fluux/src/i18n/locales/en.json` (merge into the existing top-level object; no em/en dashes):

```json
"commands": {
  "help": { "title": "Available commands", "desc": "List available commands", "usage": "/help" },
  "me": { "desc": "Send an action message", "usage": "/me <action>" },
  "say": { "desc": "Send text literally, even if it starts with a slash", "usage": "/say <text>" },
  "nick": { "desc": "Change your nickname in this room", "usage": "/nick <newnick>", "changed": "You are now known as {{nick}}" },
  "part": { "desc": "Leave this room", "usage": "/part" },
  "topic": { "desc": "View or set the room subject", "usage": "/topic [text]", "set": "Subject updated", "current": "Current subject: {{subject}}", "none": "No subject is set" },
  "kick": { "desc": "Remove someone from the room", "usage": "/kick <nick> [reason]", "done": "Kicked {{nick}}" },
  "ban": { "desc": "Ban someone from the room", "usage": "/ban <nick|jid> [reason]", "done": "Banned {{target}}" },
  "invite": { "desc": "Invite someone to the room", "usage": "/invite [jid] [reason]", "done": "Invitation sent to {{target}}" },
  "config": { "desc": "Open the room configuration", "usage": "/config" },
  "christmas": { "desc": "Send a festive surprise" },
  "indicator": { "willRun": "This will run a command", "unknownHint": "Unknown command. Use /say to send it literally." },
  "error": {
    "unknown": "Unknown command: /{{name}}",
    "moderatorOnly": "Only moderators can do that",
    "adminOnly": "Only admins can do that",
    "ownerOnly": "Only the room owner can do that",
    "needNick": "Please provide a nickname",
    "needTarget": "Please provide a nickname or address",
    "userNotFound": "No one named {{nick}} is here",
    "nickInUse": "The nickname {{nick}} is already in use",
    "nickFailed": "Could not change your nickname"
  }
}
```

- [ ] **Step 2: Add genuine translations to the remaining 32 locales**

For each other file in `apps/fluux/src/i18n/locales/`, add the same `commands` block with real, native translations of every string (not English placeholders), preserving the `{{nick}}`, `{{subject}}`, `{{target}}`, `{{name}}` interpolation tokens verbatim. Follow the tone and terminology already used elsewhere in that locale. Do not introduce em-dashes or en-dashes in any language.

- [ ] **Step 3: Run the i18n test**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: PASS (all keys present in all locales). Fix any locale flagged as missing keys.

- [ ] **Step 4: Guard against dashes**

Run: `grep -Rn "[—–]" apps/fluux/src/i18n/locales/*.json || echo "no dashes"`
Expected: `no dashes`. If any are found, replace them.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/i18n/locales
git commit -m "i18n(commands): add command namespace to all locales"
```

---

## Task 12: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `cd /Users/mremond/AIProjects/fluux-messenger && npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `cd /Users/mremond/AIProjects/fluux-messenger && npm run lint`
Expected: no errors or warnings introduced by new files.

- [ ] **Step 3: Full test suite**

Run: `cd /Users/mremond/AIProjects/fluux-messenger && npm test`
Expected: all pass, no stderr.

- [ ] **Step 4: Manual smoke via the demo (optional but recommended)**

Start the demo per the preview workflow, open a room, and verify:
- Typing `/` shows the completion menu (only commands you can run).
- `/help` opens the panel; `/me waves` sends an action and does **not** light the command indicator.
- `/nick NewName` changes the nick (or toasts a conflict); `/topic Hello` updates the subject; `/config` opens config (owner); `/invite` opens the invite modal.
- The send button shows the command variant for `/kick` and the unknown variant for `/frob`.

- [ ] **Step 5: Final commit (if any smoke fixes were needed)**

```bash
git add -A
git commit -m "fix(commands): address issues found in verification"
```

---

## Self-Review Notes (author)

- Spec coverage: parser (T1), registry/dispatch/commands (T3), capability gating both-layer (T2 + T3 block + T6/T8 visibility), toast + help-popover feedback (T5, T8), modal shortcuts via roomUiStore (T4, T9), completion menu (T6, T8, T9), composer indicator excluding `/me` (T7 + `classifyInput`), i18n (T11). All spec sections map to a task.
- Type consistency: `CommandContext.sdk.invite` (not `sendMediatedInvitation`) is used uniformly in types (T1), registry (T3), and the room context (T9, mapped from `inviteToRoom`). `resolveNick` returns `string | undefined` everywhere. `InputClass` is shared by registry, dispatcher, and composer.
- Open verification points flagged inline for the implementer: `useRoomActions` exposing `joinResult`; the `Room` subject field name; the existing close-label i18n key; the `text-fluux-warning` token fallback.
