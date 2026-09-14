import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStoreBindings, type StoreRefs } from './storeBindings'
import { createMockClientWithSDKEvents, createMockStoreRefs } from '../core/test-utils'
import { eventsStore } from '../stores/eventsStore'
import { XMPPClient } from '../core/XMPPClient'

const request = { id: 'voice-1', roomJid: 'room@example.org', jid: 'visitor@example.org/mobile', nick: 'Visitor' }
describe('voice request store bindings', () => {
  let client: ReturnType<typeof createMockClientWithSDKEvents>
  let unsubscribe: () => void
  beforeEach(() => {
    eventsStore.getState().reset()
    client = createMockClientWithSDKEvents()
    const refs = createMockStoreRefs()
    unsubscribe = createStoreBindings(client, () => ({ ...refs, events: eventsStore.getState() }) as unknown as StoreRefs)
  })
  afterEach(() => unsubscribe())

  it('deduplicates requests for the same occupant while retaining the latest form id', () => {
    client.emit('events:voice-request', request)
    client.emit('events:voice-request', { ...request, id: 'voice-2' })
    expect(eventsStore.getState().voiceRequests).toEqual([{ ...request, id: 'voice-2' }])
  })

  it.each(['room:occupant-left', 'room:occupant-joined'] as const)('clears a request on %s when voice is no longer needed', event => {
    client.emit('events:voice-request', request)
    client.emit(event, { roomJid: request.roomJid, nick: request.nick,
      occupant: { nick: request.nick, role: 'participant', affiliation: 'none' } })
    expect(eventsStore.getState().voiceRequests).toEqual([])
  })

  it.each(['room:joined', 'room:updated'] as const)('clears session state on %s leave, preserving other rooms', event => {
    client.emit('events:voice-request', request)
    client.emit('events:voice-request', { ...request, roomJid: 'other@example.org' })
    client.emit('events:voice-request-status', { roomJid: request.roomJid, status: 'sent' })
    client.emit('events:voice-request-status', { roomJid: 'other@example.org', status: 'sent' })
    if (event === 'room:joined') client.emit(event, { roomJid: request.roomJid, joined: false })
    else client.emit(event, { roomJid: request.roomJid, updates: { joined: false, isJoining: false } })
    expect(eventsStore.getState().voiceRequests).toEqual([{ ...request, roomJid: 'other@example.org' }])
    expect(eventsStore.getState().voiceRequestStatuses).toEqual({ 'other@example.org': { status: 'sent' } })
  })

  it.each([{ name: 'Renamed' }, { joined: true }])('retains voice state for room updates without a leave: %j', updates => {
    client.emit('events:voice-request', request)
    client.emit('events:voice-request-status', { roomJid: request.roomJid, status: 'sent' })
    client.emit('room:updated', { roomJid: request.roomJid, updates })
    expect(eventsStore.getState().voiceRequests).toEqual([request])
    expect(eventsStore.getState().voiceRequestStatuses[request.roomJid]).toEqual({ status: 'sent' })
  })

  it('clears moderation requests when our moderator role is revoked', () => {
    client.emit('events:voice-request', request)
    client.emit('room:self-occupant', { roomJid: request.roomJid,
      occupant: { nick: 'Me', role: 'participant', affiliation: 'member' } })
    expect(eventsStore.getState().voiceRequests).toEqual([])
  })

  it('keeps a sent request distinct from permission to speak and exposes server errors', () => {
    client.emit('events:voice-request-status', { roomJid: request.roomJid, status: 'sent' })
    expect(eventsStore.getState().voiceRequestStatuses[request.roomJid]).toEqual({ status: 'sent' })
    client.emit('events:voice-request-status', { roomJid: request.roomJid, status: 'error', error: 'forbidden' })
    expect(eventsStore.getState().voiceRequestStatuses[request.roomJid]).toEqual({ status: 'error', error: 'forbidden' })
  })
})

describe('voice request client teardown', () => {
  it('clears voice requests and statuses through the live bindings before detaching them', () => {
    eventsStore.getState().reset()
    const client = new XMPPClient({ debug: false })
    try {
      eventsStore.getState().addVoiceRequest(request)
      eventsStore.getState().setVoiceRequestStatus(request.roomJid, { status: 'sent' })
      eventsStore.getState().setVoiceRequestStatus('other@example.org', { status: 'error', error: 'forbidden' })
      eventsStore.getState().addSubscriptionRequest('contact@example.org')
      const subscriptions = eventsStore.getState().subscriptionRequests

      client.destroy()

      expect(eventsStore.getState()).toMatchObject({ voiceRequests: [], voiceRequestStatuses: {} })
      expect(eventsStore.getState().subscriptionRequests).toBe(subscriptions)
      eventsStore.getState().addVoiceRequest(request)
      client.rooms.dismissVoiceRequest(request.roomJid, request.id)
      expect(eventsStore.getState().voiceRequests).toEqual([request])
    } finally {
      client.destroy()
      eventsStore.getState().reset()
    }
  })
})
