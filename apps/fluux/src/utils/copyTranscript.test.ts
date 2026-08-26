/**
 * @vitest-environment node
 *
 * Regression suite for copying a multi-message selection that contains messages
 * whose text does not live in `<body>` (polls, closed polls, file-only messages).
 *
 * Reproduction level: this drives the two units the copy paths compose —
 * `deriveCopyBody` (what a message contributes) and `buildCopyText` (how the
 * transcript is laid out) — rather than performing a real DOM selection-and-copy.
 * `ChatView.formatMessageForCopy`, `RoomView.formatMessageForCopy` and the
 * `data-message-body` attribute all now route through `deriveCopyBody`, so this is
 * the whole derivation both copy paths use.
 */
import { describe, it, expect } from 'vitest'
import { buildCopyText, type CopyMessageMeta } from './buildCopyText'
import { deriveCopyBody, type CopyableMessage } from './copyMessageBody'

const t = (key: string, options?: Record<string, unknown>) =>
  options?.method ? `${key}:${String(options.method)}` : key

/** The derivation both `formatMessageForCopy` implementations perform. */
const meta = (
  id: string,
  from: string,
  time: string,
  message: Partial<CopyableMessage>,
): CopyMessageMeta => ({
  id,
  from,
  time,
  body: deriveCopyBody({ body: '', ...message } as CopyableMessage, t),
  date: '2024-01-15',
})

const POLL = {
  poll: {
    title: 'Lunch where?',
    options: [
      { emoji: '1️⃣', label: 'Sushi' },
      { emoji: '2️⃣', label: 'Pizza' },
    ],
    settings: { allowMultiple: false, hideResultsBeforeVote: false },
  },
} as Partial<CopyableMessage>

const POLL_CLOSED = {
  pollClosed: { title: 'Lunch where?', pollMessageId: 'm3', results: [] },
} as Partial<CopyableMessage>

const FILE_ONLY = {
  attachment: { url: 'https://e.x/report.pdf', mediaType: 'application/pdf', name: 'report.pdf' },
} as Partial<CopyableMessage>

const HEADER = '— Monday, January 15, 2024 —'

describe('copying a selection with bodyless messages', () => {
  it('includes a poll in a five-message selection instead of silently dropping it', () => {
    const out = buildCopyText([
      meta('1', 'Alice', '14:30', { body: 'Anyone hungry?' }),
      meta('2', 'Bob', '14:31', { body: 'Starving' }),
      meta('3', 'Alice', '14:32', POLL),
      meta('4', 'Bob', '14:33', { body: 'Sushi obviously' }),
      meta('5', 'Carol', '14:34', { body: 'Pizza!' }),
    ])
    expect(out).toBe(
      [
        HEADER,
        'Alice 14:30', 'Anyone hungry?',
        'Bob 14:31', 'Starving',
        'Alice 14:32', '📊 Lunch where?',
        'Bob 14:33', 'Sushi obviously',
        'Carol 14:34', 'Pizza!',
      ].join('\n'),
    )
    expect(out!.split('\n')).toHaveLength(11)
  })

  it('includes a closed-poll announcement', () => {
    const out = buildCopyText([
      meta('1', 'Alice', '14:30', { body: 'Results?' }),
      meta('2', 'Alice', '14:31', POLL_CLOSED),
    ])
    expect(out).toBe([HEADER, 'Alice 14:30', 'Results?', 'Alice 14:31', '📊 Poll closed: Lunch where?'].join('\n'))
  })

  it('includes a file-only message as its emoji and filename', () => {
    const out = buildCopyText([
      meta('1', 'Alice', '14:30', { body: 'Here you go' }),
      meta('2', 'Alice', '14:31', FILE_ONLY),
    ])
    expect(out).toBe([HEADER, 'Alice 14:30', 'Here you go', 'Alice 14:31', '📕 report.pdf'].join('\n'))
  })

  // The sharp case from the report: two messages, one a poll. The poll used to
  // contribute nothing, so fewer than two messages had a body and buildCopyText
  // returned null — the whole formatted transcript was lost to native copy.
  it('produces a transcript for a two-message selection where one is a poll', () => {
    const out = buildCopyText([
      meta('1', 'Alice', '14:30', { body: 'Deciding lunch' }),
      meta('2', 'Alice', '14:31', POLL),
    ])
    expect(out).not.toBeNull()
    expect(out).toBe([HEADER, 'Alice 14:30', 'Deciding lunch', 'Alice 14:31', '📊 Lunch where?'].join('\n'))
  })

  // Guards the byte-identity requirement: the preview formatter strips styling and
  // reply-quote prefixes; the copy path must not. This test fails if plain-text copy
  // output changes at all.
  it('copies ordinary text messages exactly as before, markup and quotes intact', () => {
    const out = buildCopyText([
      meta('1', 'Alice', '14:30', { body: 'a **bold** claim and `code`' }),
      meta('2', 'Bob', '14:31', { body: '> Alice: a **bold** claim\nI disagree', replyTo: { id: '1' } } as Partial<CopyableMessage>),
      meta('3', 'Carol', '14:32', { body: '# heading _italic_ ~~struck~~' }),
    ])
    expect(out).toBe(
      [
        HEADER,
        'Alice 14:30', 'a **bold** claim and `code`',
        'Bob 14:31', '> Alice: a **bold** claim\nI disagree',
        'Carol 14:32', '# heading _italic_ ~~struck~~',
      ].join('\n'),
    )
  })

  it('never lets a message contribute a blank or whitespace-only line', () => {
    const out = buildCopyText([
      meta('1', 'Alice', '14:30', { body: 'Real text' }),
      meta('2', 'Bob', '14:31', { body: '   \n\t ' }),
      meta('3', 'Carol', '14:32', { body: 'More text' }),
    ])
    expect(out).toBe([HEADER, 'Alice 14:30', 'Real text', 'Carol 14:32', 'More text'].join('\n'))
    expect(out!.split('\n').every((line) => line.trim().length > 0)).toBe(true)
  })

  // Pinned, not endorsed: the store preserves `body` through a retraction, so a
  // retracted message has always copied its original text even though the bubble
  // renders "message deleted". This change leaves that untouched; see the PR note.
  it('still copies a retracted message body, as it did before this change', () => {
    const out = buildCopyText([
      meta('1', 'Alice', '14:30', { body: 'Kept' }),
      meta('2', 'Bob', '14:31', { body: 'Oops wrong channel', isRetracted: true } as Partial<CopyableMessage>),
    ])
    expect(out).toBe([HEADER, 'Alice 14:30', 'Kept', 'Bob 14:31', 'Oops wrong channel'].join('\n'))
  })
})
