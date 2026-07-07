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
