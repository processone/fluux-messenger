import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'ltx'
import { XMPPClient, bindStoresForTesting } from './XMPPClient'
import { createMockXmppClient, createMockStores, createMockRoom } from './test-utils'
import roomFixture from './modules/fixtures/roomReadReplay.json'
import { ROOM_READ_MARKERS_STORAGE_KEY } from './modules/RoomReadMarkers'
import { getResource } from './jid'
import { parseMessageContent } from './modules/messagingUtils'
import { makeReadPointer } from '../stores/shared/readPointer'
import type { RoomMessage } from './types'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
const factory = vi.hoisted(() => vi.fn())
vi.mock('@xmpp/client', async original => ({ ...await original<typeof import('@xmpp/client')>(), client: factory }))
vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))
beforeEach(() => { localStorage.clear(); _resetStorageScopeForTesting(); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); _resetStorageScopeForTesting() })
// Intent: approved no-unsent-anchor and no-replay contract. The real client factory
// and preflight own classification; captured frames, a wire and store boundary are
// the fixtures. This file runs with the client transport family.
it('does not consume a position before transport starts, but retains uncertain attempted delivery', async () => {
  const mockXmppClientInstance = createMockXmppClient()
  factory.mockReturnValue(mockXmppClientInstance)
  const mockStores = createMockStores()
  const client = new XMPPClient({ debug: false })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  bindStoresForTesting(client, mockStores)
  const online = client.connect({ jid: 'user@example.com', password: 'fixture', server: 'wss://example.com/ws' })
  mockXmppClientInstance._emit('online')
  await online
  mockStores.connection.getStatus.mockReturnValue('disconnected')
  const packet = parse(roomFixture.message)
  const forwarded = roomFixture.archive.map(raw => parse(raw).getChild('result', 'urn:xmpp:mam:2')!.getChild('forwarded', 'urn:xmpp:forward:0')!)
    .find(entry => entry.getChild('message')!.attrs.id === packet.attrs.id)!
  const parsed = parseMessageContent({ messageEl: packet, body: packet.getChildText('body')!,
    delayEl: forwarded.getChild('delay', 'urn:xmpp:delay'), expectedStanzaIdBy: roomFixture.room })
  const reflected = parse(roomFixture.marker)
  const ownNick = getResource(reflected.attrs.from)!
  const actor = reflected.getChild('occupant-id', 'urn:xmpp:occupant-id:0')!.attrs.id
  const author = packet.getChild('occupant-id', 'urn:xmpp:occupant-id:0')!.attrs.id
  const row: RoomMessage = { type: 'groupchat', roomJid: roomFixture.room, id: packet.attrs.id, stanzaId: parsed.stanzaId,
    originId: parsed.originId, from: packet.attrs.from, nick: getResource(packet.attrs.from)!, occupantId: author,
    body: parsed.processedBody, timestamp: parsed.timestamp, isOutgoing: false }
  const room = createMockRoom(roomFixture.room, { nickname: ownNick, joined: true, isJoining: false, isPrivate: true, isNonAnonymous: true,
    occupants: new Map([
      [ownNick, { nick: ownNick, occupantId: actor, role: 'participant', affiliation: 'member' }],
      [row.nick, { nick: row.nick, occupantId: author, role: 'participant', affiliation: 'member' }],
    ]) })
  room.readPointer = makeReadPointer(row, 'room')
  mockStores.room.getRoom.mockReturnValue(room)
  mockStores.room.getAllRoomMessages.mockReturnValue([{ jid: roomFixture.room, messages: [row] }])
  mockStores.room.getMessageByArchiveId.mockResolvedValue(row)
  mockXmppClientInstance.iqCaller.request.mockResolvedValue(parse(roomFixture.disco))
  const markers = client.roomReadMarkers
  const watermark = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify(['user@example.com', 'watermarks'])}`
  try {
    expect(await markers.setRoomEnabled(roomFixture.room, true)).toBe(true)
    expect(await markers.ensureEligible(roomFixture.room)).toBe(true)
    mockXmppClientInstance.send.mockClear()
    Object.assign(mockXmppClientInstance, { socket: null })
    await expect(markers.viewed(roomFixture.room, row)).rejects.toThrow('Socket not available')
    expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    expect(localStorage.getItem(watermark)).toBeNull()
    Object.assign(mockXmppClientInstance, { socket: {} })
    const uncertain = new Error('uncertain delivery')
    mockXmppClientInstance.send.mockRejectedValueOnce(uncertain)
    await expect(markers.viewed(roomFixture.room, row)).rejects.toBe(uncertain)
    expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(watermark) ?? 'null')?.sent?.[roomFixture.room]?.archiveId).toBe(parsed.stanzaId)
    await markers.viewed(roomFixture.room, row)
    expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
  } finally { markers.cancelPending(); await client.disconnect() }
})
