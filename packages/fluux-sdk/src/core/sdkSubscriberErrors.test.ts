import { afterEach, describe, expect, it, vi } from 'vitest'
import { Parser } from '@xmpp/xml'
import { XMPPClient } from './XMPPClient'
import { createMockRoom } from './test-utils'
import { roomStore } from '../stores/roomStore'
import { eventsStore } from '../stores/eventsStore'
import { sessionStorageAdapter } from '../utils/sessionStorageAdapter'
import { StateSnapshot } from './modules/stateSnapshot'

const roomJid = 'burst@conference.example.test'

afterEach(() => { roomStore.getState().reset(); eventsStore.getState().reset() })

describe('SDK subscriber exception containment at XML intake', () => {
  it('reports a failing store subscriber without corrupting the parser or skipping later presences', () => {
    // Use the synchronous initial-join path so the failure occurs inside the
    // XML parser's element callback, before its cursor has returned to the root.
    roomStore.getState().addRoom(createMockRoom(roomJid))
    const client = new XMPPClient({ debug: false })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('UI subscriber failed')
    let writes = 0
    const detachStore = roomStore.subscribe(() => { if (++writes === 55) throw error })
    let delivered = 0
    const detachEvent = client.subscribe('room:occupant-joined', () => delivered++)
    const parser = new Parser()
    const parserErrors: Error[] = []
    parser.on('error', error => parserErrors.push(error))
    parser.on('element', stanza => client.rooms.handle(stanza))
    try {
      parser.write('<stream:stream xmlns:stream="http://etherx.jabber.org/streams" xmlns="jabber:client">')
      for (let i = 0; i < 200; i++) {
        for (const show of ['away', 'chat']) {
          expect(() => parser.write(`<presence from="${roomJid}/Occupant${i}"><show>${show}</show><x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="member" role="participant"/></x></presence>`)).not.toThrow()
        }
      }
      expect(delivered).toBe(400)
      expect(writes).toBe(400)
      expect(parserErrors).toEqual([])
      expect([...roomStore.getState().getRoom(roomJid)!.occupants.values()].every(occupant => occupant.show === 'chat')).toBe(true)
      expect(roomStore.getState().getRoom(roomJid)!.occupants.size).toBe(200)
      expect(report).toHaveBeenCalledExactlyOnceWith('[SDK] Store subscriber failed:', error)
    } finally {
      detachEvent()
      detachStore()
      client.destroy()
      report.mockRestore()
    }
  })
})


describe('mandatory room binding updates after subscriber errors', () => {
  it.each(['room:updated', 'room:removed', 'room:joined', 'room:occupant-joined', 'room:occupant-left', 'room:self-occupant'] as const)(
    'completes %s and notifies later subscribers', event => {
      const alice = { nick: 'Alice', role: 'visitor', affiliation: 'member' } as const
      roomStore.getState().addRoom(createMockRoom(roomJid, {
        nickname: 'Me', joined: event !== 'room:occupant-joined',
        occupants: new Map([['Alice', alice]]),
        selfOccupant: { nick: 'Me', role: 'moderator', affiliation: 'member' },
      }))
      const client = new XMPPClient({ debug: false })
      const request = { id: 'request', roomJid, nick: 'Alice', jid: 'alice@example.test' }
      eventsStore.getState().addVoiceRequest(request)
      eventsStore.getState().addVoiceRequest({ ...request, roomJid: 'other@example.test' })
      eventsStore.getState().setVoiceRequestStatus(roomJid, { status: 'sent' })
      const error = new Error('UI subscriber failed')
      const report = vi.spyOn(console, 'error').mockImplementation(() => {})
      const detachThrowing = roomStore.subscribe(() => { throw error })
      const detachSelector = roomStore.subscribe(state => state.rooms, () => { throw error })
      const roomListener = vi.fn()
      const detachRoom = roomStore.subscribe(roomListener)
      const detachEventsThrowing = eventsStore.subscribe(() => { throw error })
      const eventListener = vi.fn()
      const detachEvents = eventsStore.subscribe(eventListener)
      try {
        expect(() => {
          switch (event) {
            case 'room:updated': client.emitSDK(event, { roomJid, updates: { joined: false } }); break
            case 'room:removed': client.emitSDK(event, { roomJid }); break
            case 'room:joined': client.emitSDK(event, { roomJid, joined: false }); break
            case 'room:occupant-joined': client.emitSDK(event, { roomJid, occupant: { ...alice, role: 'participant' } }); break
            case 'room:occupant-left': client.emitSDK(event, { roomJid, nick: 'Alice' }); break
            case 'room:self-occupant': client.emitSDK(event, { roomJid, occupant: { nick: 'Me', role: 'participant', affiliation: 'member' } }); break
          }
        }).not.toThrow()
        expect(eventsStore.getState().voiceRequests).toEqual([{ ...request, roomJid: 'other@example.test' }])
        if (['room:updated', 'room:removed', 'room:joined', 'room:self-occupant'].includes(event)) {
          expect(eventsStore.getState().voiceRequestStatuses[roomJid]).toBeUndefined()
        }
        const room = roomStore.getState().getRoom(roomJid)
        if (event === 'room:removed') expect(room).toBeUndefined()
        else if (event === 'room:updated' || event === 'room:joined') expect(room?.joined).toBe(false)
        else if (event === 'room:occupant-left') expect(room?.occupants.has('Alice')).toBe(false)
        else if (event === 'room:occupant-joined') expect(room?.occupants.get('Alice')?.role).toBe('participant')
        else expect(room?.selfOccupant?.role).toBe('participant')
        expect(roomListener).toHaveBeenCalled()
        expect(eventListener).toHaveBeenCalled()
        expect(report).toHaveBeenCalledWith('[SDK] Store subscriber failed:', error)
      } finally {
        detachThrowing(); detachSelector(); detachRoom(); detachEventsThrowing(); detachEvents()
        client.destroy()
        report.mockRestore()
      }
    },
  )
})

describe('pending presence snapshots', () => {
  it('writes and restores all accepted presences before the batch timer', async () => {
    vi.useFakeTimers()
    class SnapshotClient extends XMPPClient {
      setSnapshotJid(jid: string) { this.currentJid = jid }
    }
    const jid = 'snapshot@example.test'
    const key = `fluux:rooms:${jid}`
    const client = new SnapshotClient({ debug: false, storageAdapter: sessionStorageAdapter })
    client.setSnapshotJid(jid)
    const rooms = [roomJid, 'other@conference.example.test']
    const alice = { nick: 'Alice', role: 'visitor', affiliation: 'member', show: 'away' } as const
    try {
      for (const roomJid of rooms) {
        roomStore.getState().addRoom(createMockRoom(roomJid, {
          joined: true, nickname: 'Me', occupants: new Map([['Alice', alice]]),
        }))
      }
      await client.flushStateSnapshot()
      for (const roomJid of rooms) {
        client.emitSDK('room:occupant-joined', { roomJid, occupant: { ...alice, role: 'participant', show: 'chat' } })
        expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')?.role).toBe('visitor')
      }
      const flushing = client.flushStateSnapshot()
      const serialized = JSON.parse(sessionStorage.getItem(key)!) as Array<{ occupants: [string, unknown][] }>
      expect(serialized).toHaveLength(2)
      for (const room of serialized) {
        expect(room.occupants).toEqual([['Alice', { ...alice, role: 'participant', show: 'chat' }]])
      }
      await flushing
      client.destroy()
      roomStore.getState().reset()
      const snapshot = new StateSnapshot({ storageAdapter: sessionStorageAdapter, getJid: () => jid })
      await snapshot.hydrate(jid)
      for (const roomJid of rooms) {
        expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')).toMatchObject({ role: 'participant', show: 'chat' })
      }
      snapshot.stop()
    } finally {
      client.destroy()
      sessionStorage.removeItem(key)
      vi.useRealTimers()
    }
  })
})
