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
  changeNick(jid: string, newNick: string): Promise<void>
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
  /** i18n key shown in discovery surfaces. Omitted for hidden easter eggs, which never appear there. */
  descriptionKey?: string
  usageKey?: string
  contexts: CommandContextKind[]
  capability?: CommandCapability
  /** Hidden from discovery surfaces (help panel + completion menu) but still executable when typed. */
  hidden?: boolean
  run(ctx: CommandContext, args: string): Promise<CommandResult>
}
