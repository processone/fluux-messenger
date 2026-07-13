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
      await ctx.sdk.changeNick(ctx.entityJid, newNick)
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
  contexts: ['chat', 'room'],
  // Easter egg: still runs when typed, but hidden from /help and the completion menu.
  hidden: true,
  run: async (ctx) => {
    await ctx.app.sendEasterEgg('christmas')
    return { ok: true }
  },
}

const bastille: SlashCommand = {
  name: 'bastille',
  contexts: ['chat', 'room'],
  // Easter egg: still runs when typed, but hidden from /help and the completion menu.
  // Wire name is the generic 'fireworks' so future eggs can reuse the effect.
  hidden: true,
  run: async (ctx) => {
    await ctx.app.sendEasterEgg('fireworks')
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
  bastille,
]

export function findCommand(name: string, kind: CommandContextKind): SlashCommand | undefined {
  const cmd = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))
  if (!cmd || !cmd.contexts.includes(kind)) return undefined
  return cmd
}

/** Registry-visible commands for a context, hiding capability-gated ones the user lacks and hidden ones. */
export function visibleCommands(kind: CommandContextKind, self?: CommandSelf): SlashCommand[] {
  return COMMANDS.filter((c) => !c.hidden && c.contexts.includes(kind) && hasCapability(c.capability, self))
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
