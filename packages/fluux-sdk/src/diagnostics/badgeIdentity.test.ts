import { afterEach, describe, expect, it, vi } from 'vitest'
import { xml } from '@xmpp/client'
import { badgeMessageKey, createBadgeMessageKey } from './badgeIdentity'
import { publishDiagnostic, subscribeDiagnostics, type BadgeDecisionDiagnostic } from './channel'
import * as uuid from '../utils/uuid'

// Intent: subscribed badge traces separate processing occurrences without
// changing message objects or making unsubscribed consumers mint identities.
let off: (() => void) | undefined
afterEach(() => { off?.(); off = undefined; vi.restoreAllMocks() })
function publish(source: object): void {
  publishDiagnostic('badge-decision', () => ({ kind: 'badge-decision', phase: 'arrival', status: 'pending',
    entityKind: 'room', entityId: 'team@conference.example.test', messageKey: createBadgeMessageKey(source),
  }), undefined)
}
function listen(): BadgeDecisionDiagnostic[] {
  const events: BadgeDecisionDiagnostic[] = []
  off = subscribeDiagnostics(event => { if (event.kind === 'badge-decision') events.push(event) }, { kinds: ['badge-decision'] })
  return events
}
const stanza = (from: string, occupant: string) => xml('message', { id: 'shared-id', from, type: 'groupchat' },
  xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: occupant }), xml('body', {}, 'A room message'))

describe('badge processing occurrence correlation', () => {
  it('distinguishes senders, reassigned nicknames and otherwise identical occurrences', () => {
    const events = listen()
    const first = stanza('team@conference.example.test/writer', 'occupant-a')
    const rows = [first, stanza('team@conference.example.test/other', 'occupant-b'),
      stanza('team@conference.example.test/writer', 'occupant-c'), stanza('team@conference.example.test/writer', 'occupant-a')]
    rows.forEach(publish)
    const keys = events.map(event => event.messageKey)
    expect(keys.every(Boolean)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
    publish(first)
    expect(events.at(-1)?.messageKey).toBe(keys[0])
  })

  it('carries an observed occurrence into its parsed message and retry without adding fields', () => {
    listen()
    const wire = stanza('team@conference.example.test/writer', 'occupant-a')
    publish(wire)
    const message = { id: 'shared-id', from: wire.attrs.from, roomJid: 'team@conference.example.test', occupantId: 'occupant-a', receivedAt: new Date(), body: 'A room message' }
    const before = Reflect.ownKeys(message)
    const serialized = JSON.stringify(message)
    expect(badgeMessageKey(message, wire)).toBe(badgeMessageKey(wire))
    expect(Reflect.ownKeys(message)).toEqual(before)
    expect(JSON.stringify(message)).toBe(serialized)
    const retry = stanza('team@conference.example.test/writer', 'occupant-a')
    expect(badgeMessageKey(message, retry)).toBe(badgeMessageKey(wire))
    expect(badgeMessageKey(retry)).toBe(badgeMessageKey(wire))
  })

  it('does not combine incoming and outgoing chats that reuse an id', () => {
    const events = listen()
    const incoming = { id: 'shared-id', from: 'peer@example.test', isOutgoing: false }
    const outgoing = { id: 'shared-id', from: 'self@example.test', isOutgoing: true }
    publish(incoming); publish(outgoing)
    expect(events[0].messageKey).not.toBe(events[1].messageKey)
  })

  it('does not generate UUIDs or retain occurrence keys without subscribers', () => {
    const generate = vi.spyOn(uuid, 'generateUUID')
    const wire = stanza('team@conference.example.test/writer', 'occupant-a')
    const message = { id: 'shared-id', from: wire.attrs.from }
    expect(badgeMessageKey(message, wire)).toBeUndefined()
    publish(wire)
    publish(message)
    expect(badgeMessageKey(wire)).toBeUndefined()
    expect(badgeMessageKey(message)).toBeUndefined()
    expect(generate).not.toHaveBeenCalled()
  })
})
