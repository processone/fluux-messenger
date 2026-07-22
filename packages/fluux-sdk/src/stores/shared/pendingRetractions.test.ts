import { describe, it, expect } from 'vitest'
import {
  addPendingRetraction,
  applyPendingRetractions,
  PENDING_RETRACTION_CAP,
  type PendingRetraction,
} from './pendingRetractions'

const AT = new Date('2026-07-22T03:53:00Z').getTime()

function entry(targetId: string, actorJid = 'contact@example.com', retractedAt = AT): PendingRetraction {
  return { targetId, actorJid, retractedAt }
}

function message(id: string, extra: Record<string, unknown> = {}) {
  return { id, from: 'contact@example.com', body: 'hello', ...extra }
}

const isAuthor = (m: { from: string }, record: PendingRetraction) => m.from === record.actorJid

describe('addPendingRetraction', () => {
  it('appends a record', () => {
    expect(addPendingRetraction([], entry('a'))).toEqual([entry('a')])
  })

  it('returns the same array when the target is already recorded', () => {
    const existing = [entry('a')]
    expect(addPendingRetraction(existing, entry('a'))).toBe(existing)
  })

  it('caps the list, dropping the oldest record', () => {
    let list: PendingRetraction[] = []
    for (let i = 0; i < PENDING_RETRACTION_CAP + 5; i++) {
      list = addPendingRetraction(list, entry(`t${i}`))
    }
    expect(list).toHaveLength(PENDING_RETRACTION_CAP)
    expect(list[0].targetId).toBe('t5')
  })
})

describe('applyPendingRetractions', () => {
  it('tombstones a target that is now present and reports it applied', () => {
    const messages = [message('m1'), message('m2')]

    const result = applyPendingRetractions(messages, [entry('m2')], isAuthor)

    expect(result.messages[1]).toMatchObject({ id: 'm2', isRetracted: true, retractedAt: new Date(AT) })
    expect(result.messages[0]).toBe(messages[0])
    expect(result.applied).toEqual([{ messageId: 'm2', retractedAt: new Date(AT) }])
    expect(result.remaining).toEqual([])
  })

  it('resolves the target through any id tier (stanza-id, origin-id)', () => {
    const messages = [message('m1', { stanzaId: 'srv-1' }), message('m2', { originId: 'org-2' })]

    const result = applyPendingRetractions(messages, [entry('srv-1'), entry('org-2')], isAuthor)

    expect(result.messages[0]).toMatchObject({ isRetracted: true })
    expect(result.messages[1]).toMatchObject({ isRetracted: true })
    expect(result.remaining).toEqual([])
  })

  it('keeps a record pending when its target is not present', () => {
    const messages = [message('m1')]

    const result = applyPendingRetractions(messages, [entry('absent')], isAuthor)

    expect(result.messages).toBe(messages)
    expect(result.applied).toEqual([])
    expect(result.remaining).toEqual([entry('absent')])
  })

  it('drops a record whose author does not match the target — never tombstones', () => {
    const messages = [message('m1', { from: 'someone-else@example.com' })]

    const result = applyPendingRetractions(messages, [entry('m1')], isAuthor)

    expect(result.messages).toBe(messages)
    expect(result.applied).toEqual([])
    expect(result.remaining).toEqual([])
  })

  it('resolves an already-retracted target without rewriting the array', () => {
    const messages = [message('m1', { isRetracted: true })]

    const result = applyPendingRetractions(messages, [entry('m1')], isAuthor)

    expect(result.messages).toBe(messages)
    expect(result.applied).toEqual([])
    expect(result.remaining).toEqual([])
  })

  it('returns the input array untouched when there is nothing pending', () => {
    const messages = [message('m1')]

    const result = applyPendingRetractions(messages, [], isAuthor)

    expect(result.messages).toBe(messages)
    expect(result.remaining).toEqual([])
  })
})
