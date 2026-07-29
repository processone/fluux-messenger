// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { initTokenizer, isKind, resetValuesForTesting } from './values'
import {
  convToken,
  messageRef,
  queryRef,
  roomToken,
  warmConversation,
  warmRoom,
} from './identity'

beforeEach(async () => {
  localStorage.clear()
  resetValuesForTesting()
  await initTokenizer()
})

describe('entity identity', () => {
  it('strips the resource, so one contact on two devices is one token', async () => {
    await warmConversation('someone@example.com/phone')
    await warmConversation('someone@example.com/desktop')
    expect(convToken('someone@example.com/phone').s).toBe(
      convToken('someone@example.com/desktop').s,
    )
  })

  it('warming a full JID makes the bare JID resolve, and vice versa', async () => {
    // Both sides must narrow identically, or a pre-warm keyed on a full JID would
    // leave the breadcrumb path resolving to the sentinel forever.
    await warmConversation('someone@example.com/phone')
    expect(convToken('someone@example.com').s).toMatch(/^c:[0-9a-f]{16}$/)
  })

  it('never emits the local part or the domain', async () => {
    await warmConversation('alice@example.com')
    const s = convToken('alice@example.com').s
    expect(s).not.toContain('alice')
    expect(s).not.toContain('example')
    expect(s).toMatch(/^c:[0-9a-f]{16}$/)
  })

  it('separates the conversation and room namespaces for the same JID', async () => {
    // A bare JID can name a 1:1 contact on one server and a MUC on another. Sharing
    // one token space would assert an identity that does not exist.
    await warmConversation('shared@example.com')
    await warmRoom('shared@example.com')
    expect(convToken('shared@example.com').s).not.toBe(roomToken('shared@example.com').s)
  })

  it('returns the sentinel rather than the raw JID when not warmed', () => {
    expect(convToken('cold@example.com').s).toBe('c:unresolved')
  })

  it('tolerates an empty or malformed JID without emitting it', () => {
    for (const bad of ['', '   ', 'no-at-sign', '@', 'a@']) {
      const s = convToken(bad).s
      expect(s === 'c:unresolved' || /^c:[0-9a-f]{16}$/.test(s)).toBe(true)
      if (bad.trim()) expect(s).not.toContain(bad.trim())
    }
  })
})

describe('ephemeral identity', () => {
  it('gives messages and queries distinct ref spaces', () => {
    expect(messageRef('shared-id')!.s).not.toBe(queryRef('shared-id')!.s)
  })

  it('produces session-local refs, not entity tokens', () => {
    expect(isKind(messageRef('m1')!, 'ref')).toBe(true)
    expect(isKind(messageRef('m1')!, 'token')).toBe(false)
  })

  it('is stable for the same id within a session', () => {
    expect(messageRef('m1')).toBe(messageRef('m1'))
  })

  it('resolves synchronously, with no warming step', () => {
    // The whole point of the ephemeral class: an id first seen at the moment a
    // breadcrumb is recorded still gets a distinct ref.
    expect(messageRef('never-seen-before')!.s).toMatch(/^s:m[0-9]+$/)
  })
})
