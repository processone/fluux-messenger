/**
 * One-to-one conversations of the showcase scene: a team preparing a product
 * launch evening. Each thread shows a different kind of content, and none shows
 * an error or edge-case state; those stay in the default demo fixture.
 */

import type { Conversation, Message } from '@fluux/sdk'
import { daysAgo, hoursAgo, minutesAgo } from '@fluux/sdk/demo'
import { SELF_JID } from '../constants'
import { chatMessage } from './builders'
import { ASSETS, AVA, EMMA, JAMES, LIAM, OLIVIA, SOPHIA } from './constants'

const verified = { securityContext: { protocolId: 'openpgp', trust: 'verified' as const } }

function emma(): Message[] {
  const m = (id: string, from: string, body: string, at: Date, extras = {}) => chatMessage(EMMA, `emma-${id}`, from, body, at, extras)
  return [
    m('1', EMMA, 'Venue confirmed for Thursday! 120 seats and a rooftop terrace 🌇', daysAgo(1)),
    m('2', 'self', 'Amazing. Could we have the poster ready by tomorrow?', daysAgo(1)),
    m('3', EMMA, 'Already on it ✏️', daysAgo(1)),
    m('4', EMMA, 'Here is the final poster for the launch night 🎉', minutesAgo(42), {
      attachment: { url: `${ASSETS}/poster.jpg`, name: 'launch-night-poster.jpg', mediaType: 'image/jpeg', size: 74_977, width: 1200, height: 900 },
      reactions: { '😍': [SELF_JID] },
    }),
    m('5', 'self', 'That looks gorgeous. Sending it to the printer right now', minutesAgo(40), {
      reactions: { '🙌': [EMMA] },
    }),
    m('6', EMMA, 'Thanks! Run-through at 4? ☕', minutesAgo(2), {
      replyTo: { id: 'showcase-emma-5', fallbackBody: 'That looks gorgeous. Sending it to the printer right now' },
    }),
    m('7', EMMA, 'I will bring the badges for the volunteers 🎟️', minutesAgo(1)),
  ]
}

function ava(): Message[] {
  const m = (id: string, from: string, body: string, at: Date, extras = {}) => chatMessage(AVA, `ava-${id}`, from, body, at, { ...verified, ...extras })
  return [
    m('0a', 'self', 'Any news from the venue?', daysAgo(1)),
    m('0b', AVA, 'They accepted our offer, catering included 🥂', daysAgo(1), { reactions: { '🎉': [SELF_JID] } }),
    m('0c', 'self', 'Fantastic. Let me know once the contract is signed', daysAgo(1)),
    m('1', AVA, 'The venue contract is signed ✍️', hoursAgo(3)),
    m('2', 'self', 'Great news! Can you send me the access details?', hoursAgo(2.9)),
    m('3', AVA, 'Sure. Sending them here since this chat is end-to-end encrypted 🔒', minutesAgo(13)),
    m('4', AVA, 'Door code is 4827, and the Wi-Fi password is printed on the badges', minutesAgo(12), {
      // Decrypted on this device, so saving it keeps its text (sealed to the account's key in a real save).
      contentAvailability: { state: 'ready' },
      reactions: { '🙏': [SELF_JID] },
    }),
  ]
}

function liam(): Message[] {
  const m = (id: string, from: string, body: string, at: Date, extras = {}) => chatMessage(LIAM, `liam-${id}`, from, body, at, extras)
  return [
    m('1', LIAM, 'Quick note on the livestream setup', daysAgo(2), {
      attachment: { url: './demo/voice-note.ogg', name: 'livestream-setup.ogg', mediaType: 'audio/ogg', size: 42_000, duration: 3 },
    }),
    m('2', 'self', 'You are a star ⭐', daysAgo(2)),
    m('3', LIAM, 'Press kit is online, in case journalists ask', daysAgo(2), {
      linkPreview: {
        url: 'https://press.fluux.chat/launch-night',
        title: 'Launch Night media resources',
        description: 'Logos, photos and speaker bios for the launch evening.',
        siteName: 'press.fluux.chat',
        image: `${ASSETS}/og.jpg`,
      },
    }),
  ]
}

function sophia(): Message[] {
  const m = (id: string, from: string, body: string, at: Date, extras = {}) => chatMessage(SOPHIA, `sophia-${id}`, from, body, at, extras)
  return [
    m('1', 'self', 'How is the talk coming along?', hoursAgo(2)),
    m('2', SOPHIA, 'Nearly there! Here are my slides, any feedback welcome', hoursAgo(1.5), {
      attachment: { url: './demo/fluux-sdk-api-reference.pdf', name: 'building-bots-slides.pdf', mediaType: 'application/pdf', size: 186_000 },
    }),
  ]
}

function james(): Message[] {
  const m = (id: string, from: string, body: string, at: Date, extras = {}) => chatMessage(JAMES, `james-${id}`, from, body, at, extras)
  return [
    m('1', JAMES, 'RSVP page is live 🚀 The seat counter rounds like this:', hoursAgo(3)),
    m('2', JAMES, '```ts\nexport function seatsLeft(capacity: number, rsvps: number): string {\n  const left = Math.max(capacity - rsvps, 0)\n  return left === 0 ? \'Waiting list only\' : `${left} seats left`\n}\n```', hoursAgo(3)),
    m('3', 'self', 'Clean. Ship it!', hoursAgo(2.8), { reactions: { '👍': [JAMES] } }),
  ]
}

function olivia(): Message[] {
  const m = (id: string, from: string, body: string, at: Date, extras = {}) => chatMessage(OLIVIA, `olivia-${id}`, from, body, at, extras)
  return [
    m('1', OLIVIA, 'Found a trail for Friday morning, to recover from the party 🥾', daysAgo(1), {
      attachment: { url: `${ASSETS}/trail.jpg`, name: 'sunrise-trail.jpg', mediaType: 'image/jpeg', size: 37_910, width: 1200, height: 800 },
    }),
    m('2', 'self', 'Count me in!', daysAgo(1), { reactions: { '🎉': [OLIVIA] } }),
  ]
}

const ENTRIES: Array<{ jid: string; name: string; unreadCount: number; build: () => Message[] }> = [
  { jid: EMMA, name: 'Emma Ward', unreadCount: 0, build: emma },
  { jid: AVA, name: 'Ava Reyes', unreadCount: 0, build: ava },
  { jid: SOPHIA, name: 'Sophia Lin', unreadCount: 1, build: sophia },
  { jid: JAMES, name: 'James Hale', unreadCount: 0, build: james },
  { jid: OLIVIA, name: 'Olivia Park', unreadCount: 0, build: olivia },
  { jid: LIAM, name: 'Liam Ross', unreadCount: 0, build: liam },
]

export function buildShowcaseConversations(): { conversations: Conversation[]; messages: Map<string, Message[]> } {
  const messages = new Map<string, Message[]>()
  const conversations = ENTRIES.map(({ jid, name, unreadCount, build }) => {
    const thread = build()
    messages.set(jid, thread)
    return { id: jid, name, type: 'chat' as const, unreadCount, lastMessage: thread.at(-1) }
  })
  return { conversations, messages }
}
