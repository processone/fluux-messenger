import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connectionStore } from '@fluux/sdk/stores'
import type { SDKEvents } from '@fluux/sdk'
import { onSignInAccepted } from './signInAccepted'

// The real connection store, whose status the wait reads (the test setup
// replaces it with a stub by default).
vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  connectionStore: (await import('@fluux/sdk/stores')).connectionStore,
}))

// Source: review of the fix that signs in with a changed password. A sign-in
// that connect() hands to the automatic reconnection is saved when that
// reconnection signs in; once the connection ends without it, a later sign-in
// (such as one typed in the login form) must not save this one's password.

type Accepted = SDKEvents['connection:authenticated']

function sdkClient() {
  const listeners = new Set<(event: Accepted) => void>()
  return {
    client: {
      subscribe: (_event: 'connection:authenticated', listener: (event: Accepted) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    accept(jid: string): void {
      const event: Accepted = { jid, authentication: { method: 'password', mechanism: 'SCRAM-SHA-1' } }
      for (const listener of [...listeners]) listener(event)
    },
  }
}

describe('onSignInAccepted', () => {
  beforeEach(() => {
    connectionStore.getState().setStatus('disconnected')
  })

  it('waits through the automatic reconnection and saves when it signs in', () => {
    const { client, accept } = sdkClient()
    const persist = vi.fn()
    onSignInAccepted(client, 'user@example.com/fluux-1', persist)

    connectionStore.getState().setStatus('connecting')
    connectionStore.getState().setStatus('reconnecting')
    connectionStore.getState().setStatus('online')
    accept('user@example.com/fluux-1')
    accept('user@example.com/fluux-1')

    expect(persist).toHaveBeenCalledTimes(1)
  })

  // The login form stays usable while a first sign-in retries, and connect()
  // ignores a request made meanwhile: only the retrying request's password
  // has been tried when the server accepts the sign-in.
  it.each(['connecting', 'reconnecting'] as const)(
    'saves the password of the request being retried, not of one made while %s',
    (inProgress) => {
      const { client, accept } = sdkClient()
      const saved: string[] = []
      onSignInAccepted(client, 'user@example.com/fluux-1', () => saved.push('password-A'))
      connectionStore.getState().setStatus('connecting')
      connectionStore.getState().setStatus(inProgress)

      onSignInAccepted(client, 'user@example.com/fluux-1', () => saved.push('password-B'))
      connectionStore.getState().setStatus('online')
      accept('user@example.com/fluux-1')

      expect(saved).toEqual(['password-A'])
    },
  )

  it.each([
    { end: 'error', why: 'a final failure' },
    { end: 'disconnected', why: 'a cancellation or logout' },
  ] as const)('stops waiting when the reconnection ends with $why', ({ end }) => {
    const { client, accept } = sdkClient()
    const persist = vi.fn()
    onSignInAccepted(client, 'user@example.com/fluux-1', persist)

    connectionStore.getState().setStatus('connecting')
    connectionStore.getState().setStatus('reconnecting')
    connectionStore.getState().setStatus(end)
    connectionStore.getState().setStatus('connecting')
    connectionStore.getState().setStatus('online')
    accept('user@example.com/fluux-1')

    expect(persist).not.toHaveBeenCalled()
  })
})
