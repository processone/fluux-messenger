import { describe, it, expect } from 'vitest'
import { createMessageLookup, findMessageById } from './messageLookup'

describe('createMessageLookup', () => {
  it('should index messages by client id', () => {
    const messages = [
      { id: 'msg-1', body: 'Hello' },
      { id: 'msg-2', body: 'World' },
    ]

    const lookup = createMessageLookup(messages)

    expect(lookup.get('msg-1')).toEqual(messages[0])
    expect(lookup.get('msg-2')).toEqual(messages[1])
  })

  it('should index messages by stanza-id when present', () => {
    const messages = [
      { id: 'client-id-1', stanzaId: '1766999538188692', body: 'Hello' },
      { id: 'client-id-2', body: 'No stanza-id' },
    ]

    const lookup = createMessageLookup(messages)

    // Can find by client id
    expect(lookup.get('client-id-1')).toEqual(messages[0])
    // Can also find by stanza-id
    expect(lookup.get('1766999538188692')).toEqual(messages[0])
    // Message without stanza-id only findable by client id
    expect(lookup.get('client-id-2')).toEqual(messages[1])
  })

  it('should allow reply lookup by stanza-id (MAM archive ID)', () => {
    // Simulate real-world scenario: message has both ids, reply references stanza-id
    const originalMessage = {
      id: '148a9d4f-68ee-4c5c-abca-685bc7981c2b',
      stanzaId: '1766999538188692',
      nick: 'alice',
      body: 'Original message',
    }

    const replyMessage = {
      id: '7283b0f7-d48e-4433-8cb8-644b3e78d823',
      stanzaId: '1766999746428466',
      nick: 'bob',
      body: 'Reply to original',
      replyTo: { id: '1766999538188692' }, // References stanza-id, not client id
    }

    const lookup = createMessageLookup([originalMessage, replyMessage])

    // Reply can find original by stanza-id
    const found = lookup.get(replyMessage.replyTo.id)
    expect(found).toEqual(originalMessage)
    expect(found?.nick).toBe('alice')
    expect(found?.body).toBe('Original message')
  })

  it('should handle empty message array', () => {
    const lookup = createMessageLookup([])
    expect(lookup.size).toBe(0)
  })

  it('should handle messages with undefined stanzaId', () => {
    const messages = [
      { id: 'msg-1', stanzaId: undefined, body: 'Test' },
    ]

    const lookup = createMessageLookup(messages)

    expect(lookup.size).toBe(1)
    expect(lookup.get('msg-1')).toEqual(messages[0])
    expect(lookup.get('undefined')).toBeUndefined()
  })

  it('should index corrected message by correction stanza-ids', () => {
    // When a message is corrected in a MUC room, the correction gets a new
    // stanza-id from the MUC service. Other clients may reference this
    // correction stanza-id in replies.
    const correctedMessage = {
      id: 'client-uuid-1',
      stanzaId: 'original-stanza-id',
      correctionStanzaIds: ['correction-stanza-id-1', 'correction-stanza-id-2'],
      body: 'Corrected body',
    }

    const lookup = createMessageLookup([correctedMessage])

    // Findable by client id
    expect(lookup.get('client-uuid-1')).toEqual(correctedMessage)
    // Findable by original stanza-id
    expect(lookup.get('original-stanza-id')).toEqual(correctedMessage)
    // Findable by correction stanza-ids (reply references)
    expect(lookup.get('correction-stanza-id-1')).toEqual(correctedMessage)
    expect(lookup.get('correction-stanza-id-2')).toEqual(correctedMessage)
  })

  it('should allow reply lookup by correction stanza-id (XEP-0308 + XEP-0461)', () => {
    // Real-world scenario: debacle sends a message, edits it, taba replies
    // to the edited version. Taba's client references the correction's stanza-id.
    const originalMessage = {
      id: '77a43044-1980-4490-939e-debacle-uuid',
      stanzaId: '2026-04-02-original-id',
      correctionStanzaIds: ['2026-04-02-04dc7d1dd7596361'],
      nick: 'debacle',
      body: 'Corrected message body',
    }

    const replyMessage = {
      id: '2f052c83-taba-uuid',
      stanzaId: '2026-04-02-taba-stanza',
      nick: 'taba',
      body: 'A rough estimate would be nice',
      replyTo: { id: '2026-04-02-04dc7d1dd7596361' }, // References correction stanza-id
    }

    const lookup = createMessageLookup([originalMessage, replyMessage])

    // Reply can find original by correction stanza-id
    const found = lookup.get(replyMessage.replyTo.id)
    expect(found).toEqual(originalMessage)
    expect(found?.nick).toBe('debacle')
  })

  it('should index messages by origin-id when present (XEP-0359)', () => {
    // After XEP-0308, an inbound correction references the sender-assigned
    // origin-id. If a MUC rewrote the message id, the original is only
    // resolvable via origin-id.
    const messages = [
      { id: 'muc-rewritten-id', originId: 'sender-origin-uuid', stanzaId: 'mam-id', body: 'Hello' },
    ]

    const lookup = createMessageLookup(messages)

    expect(lookup.get('muc-rewritten-id')).toEqual(messages[0])
    expect(lookup.get('mam-id')).toEqual(messages[0])
    expect(lookup.get('sender-origin-uuid')).toEqual(messages[0])
  })

  it('should not let an origin-id shadow another message\'s real id (no over-match)', () => {
    // origin-id is sender-controlled (XEP-0359) and only a fallback tier: a
    // message owning the value as its real id must win over a different message
    // that merely carries it as origin-id, regardless of array order.
    const messages = [
      { id: 'real-id-owner', body: 'owner (listed first)' },
      { id: 'other', originId: 'real-id-owner', body: 'origin-id carrier' },
    ]

    const lookup = createMessageLookup(messages)

    expect(lookup.get('real-id-owner')?.body).toBe('owner (listed first)')
  })

  it('should handle messages without correctionStanzaIds', () => {
    const messages = [
      { id: 'msg-1', stanzaId: 'stanza-1', body: 'No corrections' },
      { id: 'msg-2', body: 'No stanza-id either' },
    ]

    const lookup = createMessageLookup(messages)

    expect(lookup.size).toBe(3) // msg-1, stanza-1, msg-2
    expect(lookup.get('msg-1')).toEqual(messages[0])
    expect(lookup.get('stanza-1')).toEqual(messages[0])
    expect(lookup.get('msg-2')).toEqual(messages[1])
  })
})

describe('findMessageById', () => {
  it('should find message by client id', () => {
    const messages = [
      { id: 'msg-1', body: 'Hello' },
      { id: 'msg-2', body: 'World' },
    ]

    const found = findMessageById(messages, 'msg-1')
    expect(found).toEqual(messages[0])
  })

  it('should find message by stanza-id', () => {
    const messages = [
      { id: 'client-id', stanzaId: 'mam-archive-id', body: 'Hello' },
    ]

    const found = findMessageById(messages, 'mam-archive-id')
    expect(found).toEqual(messages[0])
  })

  it('should return undefined when not found', () => {
    const messages = [
      { id: 'msg-1', body: 'Hello' },
    ]

    const found = findMessageById(messages, 'nonexistent')
    expect(found).toBeUndefined()
  })

  it('should prefer id match over stanzaId (returns first match)', () => {
    const messages = [
      { id: 'id-1', stanzaId: 'stanza-1', body: 'First' },
      { id: 'stanza-1', body: 'Second has id matching first stanzaId' },
    ]

    // Looking for 'stanza-1' should find first message (by stanzaId)
    // because find() returns the first match
    const found = findMessageById(messages, 'stanza-1')
    expect(found?.body).toBe('First')
  })

  it('should find message by correction stanza-id', () => {
    const messages = [
      {
        id: 'client-id',
        stanzaId: 'original-stanza',
        correctionStanzaIds: ['correction-stanza-1'],
        body: 'Edited message',
      },
    ]

    const found = findMessageById(messages, 'correction-stanza-1')
    expect(found).toEqual(messages[0])
  })

  it('should find message by origin-id (XEP-0308 correction reference)', () => {
    const messages = [
      { id: 'muc-rewritten-id', originId: 'sender-origin-uuid', stanzaId: 'mam-id', body: 'Hello' },
    ]

    const found = findMessageById(messages, 'sender-origin-uuid')
    expect(found).toEqual(messages[0])
  })

  it('should prefer a strong-tier (id/stanzaId) match over an origin-id match', () => {
    // Guards against over-matching: an earlier message carrying the value as a
    // (spoofable) origin-id must not shadow the later message that owns it as id.
    const messages = [
      { id: 'other', originId: 'shared-value', body: 'origin-id carrier (first)' },
      { id: 'shared-value', body: 'real id owner' },
    ]

    const found = findMessageById(messages, 'shared-value')
    expect(found?.body).toBe('real id owner')
  })

  it('should return undefined when correction stanza-id does not match', () => {
    const messages = [
      {
        id: 'client-id',
        stanzaId: 'original-stanza',
        correctionStanzaIds: ['correction-stanza-1'],
        body: 'Edited message',
      },
    ]

    const found = findMessageById(messages, 'nonexistent-correction')
    expect(found).toBeUndefined()
  })
})
