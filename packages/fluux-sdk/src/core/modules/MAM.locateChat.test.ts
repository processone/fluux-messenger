import { describe, expect, it, vi } from 'vitest'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader } from '../test-utils'
import type { Message } from '../types'

const CHAT = 'juliet@capulet.example'
const message = (extra: Partial<Message>): Message => ({
  type: 'chat', conversationId: CHAT, id: 'm1', from: CHAT, body: 'hi', timestamp: new Date(500), isOutgoing: false, ...extra,
} as Message)

// Intent: opening a saved one-to-one message must land on that message, never on
// another one that merely shares a client-chosen id (accepted FLM-333 plan: open = jump).
function setup(options: { resident?: Message; cached?: Message; archiveRow?: Message; context?: Message[] }) {
  const emitSDK = vi.fn()
  const chat = {
    getMessage: vi.fn(() => options.resident),
    resolveReactionTarget: vi.fn(async () => options.cached),
    reconcileHistoryMessages: vi.fn(async (rows: Message[]) => rows),
  }
  const deps = {
    stores: { chat }, presence: createMockPresenceReader(), getCurrentJid: () => 'romeo@montague.example',
    getXmpp: () => null, sendStanza: vi.fn(), sendIQ: vi.fn(), emit: vi.fn(), emitSDK, registerMAMCollector: () => () => {},
  } as unknown as ModuleDependencies
  const mam = new MAM(deps)
  const internals = mam as unknown as Record<string, unknown>
  internals.lookUpArchivedMessage = vi.fn(async () => options.archiveRow
    ? { kind: 'found', timestamp: 500, row: options.archiveRow } : { kind: 'absent' })
  internals.fetchContext = vi.fn(async () => ({ messages: options.context ?? [], complete: true }))
  return { mam, emitSDK }
}

describe('locateChatMessage identity', () => {
  it('rejects a cached message with another sender that shares the origin id', async () => {
    const { mam } = setup({ resident: message({ from: 'mercutio@capulet.example', originId: 'same' }) })
    const result = await mam.locateChatMessage(CHAT, { originId: 'same', from: CHAT })
    expect(result.kind).not.toBe('found')
  })

  it('rejects a cached message whose archive id differs from the saved one', async () => {
    const { mam } = setup({ cached: message({ stanzaId: 'other', originId: 'same' }) })
    const result = await mam.locateChatMessage(CHAT, { stanzaId: 'wanted', originId: 'same', from: CHAT })
    expect(result.kind).not.toBe('found')
  })

  it('stores the exact archive row when the context page does not hold it, so the jump can load it', async () => {
    const row = message({ stanzaId: 'wanted' })
    const { mam, emitSDK } = setup({ archiveRow: row })
    const result = await mam.locateChatMessage(CHAT, { stanzaId: 'wanted', from: CHAT })
    expect(result).toMatchObject({ kind: 'found', source: 'archive' })
    expect(emitSDK).toHaveBeenCalledWith('chat:history-messages', expect.objectContaining({ conversationId: CHAT, messages: [row] }))
  })

  it('says unknown, not absent, when a time lookup ends before the window does', async () => {
    const { mam } = setup({})
    ;(mam as unknown as Record<string, unknown>).fetchContext = vi.fn(async () => ({ messages: [], complete: false }))
    expect((await mam.locateChatMessage(CHAT, { sentAt: 500, from: CHAT })).kind).toBe('unknown')
  })
})
