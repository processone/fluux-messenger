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
