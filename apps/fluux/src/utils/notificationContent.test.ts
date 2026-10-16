import { describe, expect, it } from 'vitest'
import type { Conversation, Message, Room, RoomMessage } from '@fluux/sdk'
import fixtures from '../../../../tests/fixtures/notification-content.json'
import en from '@/i18n/locales/en.json'
import { buildLocalMessageNotification } from './localMessageNotification'
import { buildPushNotification, type PushPayloadData } from './pushNotificationCoalesce'

function translate(key: string, options?: Record<string, unknown>): string {
  let value: unknown = en
  for (const part of key.split('.')) value = (value as Record<string, unknown>)[part]
  if (typeof value !== 'string') throw new Error(`Missing fixture translation: ${key}`)
  return value.replace(/{{(\w+)}}/g, (_, name: string) => String(options?.[name] ?? ''))
}

describe('shared notification content contract v1', () => {
  it('uses the supported fixture version and current localized words', () => {
    expect(fixtures.version).toBe(1)
    expect(fixtures.words).toEqual(en.notificationPreview)
  })
  for (const fixture of fixtures.cases) {
    if ('app' in fixture && fixture.app) {
      const input = fixture.app
      for (const web of [false, true]) it(`${fixture.id}: app ${web ? 'web' : 'native'}`, () => {
        const room = 'room' in input && input.room
        const name = 'name' in input ? input.name : room ? 'Team' : 'Alice'
        const common = { id: 'one', from: 'alice@example.test', timestamp: new Date(0), isOutgoing: false, ...input.message }
        const unreadCount = 'count' in input ? input.count : 1
        const target = room
          ? { kind: 'room' as const, entity: { jid: 'team@conference.example.test', name, unreadCount } as Room,
            message: { ...common, type: 'groupchat', roomJid: 'team@conference.example.test', nick: 'Alice' } as RoomMessage }
          : { kind: 'chat' as const, entity: { id: 'alice@example.test', name, unreadCount } as Conversation,
            message: { ...common, type: 'chat', conversationId: 'alice@example.test' } as Message }
        const built = buildLocalMessageNotification(target, translate, 'en', web)
        const expected = web ? input.web : input.expected
        expect(built ? { title: built.title, body: built.body } : null).toEqual(expected)
      })
    }
    if ('push' in fixture && fixture.push) it(`${fixture.id}: service worker push`, () => {
      const input = fixture.push!
      const built = buildPushNotification(input.payload as PushPayloadData, {
        existingCount: input.existingCount ?? 0, isAndroid: false, locale: 'en',
      })
      expect({ title: built.title, body: built.options.body }).toEqual(input.expected)
    })
  }
})
