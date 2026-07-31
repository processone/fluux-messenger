import { describe, it, expect } from 'vitest'
import { HatCommandError } from '@fluux/sdk'
import { getHatCommandErrorMessage } from './hatCommandErrorMessage'

const t = (key: string) => {
  const strings: Record<string, string> = {
    'rooms.hatDestroyError': 'Failed to delete hat',
    'rooms.hatCommandNoReply': 'The server did not reply',
  }
  return strings[key] ?? key
}

const ROOM = 'room@conference.example.com'
const NODE = 'urn:xmpp:hats:commands:destroy'

describe('getHatCommandErrorMessage', () => {
  it('names a timeout as the cause instead of a bare failure string', () => {
    const err = new HatCommandError(ROOM, NODE, 'timeout')

    expect(getHatCommandErrorMessage(t, err, 'rooms.hatDestroyError'))
      .toBe('Failed to delete hat — The server did not reply')
  })

  it("prefers the server's own text when it sent one", () => {
    const err = new HatCommandError(ROOM, NODE, 'forbidden', {
      errorType: 'auth',
      text: 'Only owners may manage hats',
    })

    expect(getHatCommandErrorMessage(t, err, 'rooms.hatDestroyError'))
      .toBe('Failed to delete hat — Only owners may manage hats')
  })

  it('falls back to the condition when the server sent no text', () => {
    const err = new HatCommandError(ROOM, NODE, 'item-not-found')

    expect(getHatCommandErrorMessage(t, err, 'rooms.hatDestroyError'))
      .toBe('Failed to delete hat — item-not-found')
  })

  it('invents no cause for a failure that carries none', () => {
    const err = new HatCommandError(ROOM, NODE, 'undefined-condition', { message: 'Not connected' })

    expect(getHatCommandErrorMessage(t, err, 'rooms.hatDestroyError'))
      .toBe('Failed to delete hat')
  })

  it('leaves a non-SDK error with the plain operation message', () => {
    expect(getHatCommandErrorMessage(t, new Error('boom'), 'rooms.hatDestroyError'))
      .toBe('Failed to delete hat')
  })
})
