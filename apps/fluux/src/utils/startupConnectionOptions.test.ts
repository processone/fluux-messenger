import { describe, expect, it } from 'vitest'
import { buildStartupConnectionOptions } from './startupConnectionOptions'

describe('buildStartupConnectionOptions', () => {
  const connection = Object.freeze({
    jid: 'user@example.com',
    password: 'password',
    server: 'wss://custom.example/xmpp',
    fallbackWebSocketUrl: undefined,
    resource: 'fluux-d12345',
    lang: 'fr',
  })

  it('can reuse resolved connection details across attempts without leaking policy options', () => {
    const session = buildStartupConnectionOptions(connection, {
      kind: 'session', hasNativeConnectionKeepalive: true, rememberSession: undefined,
    })
    const retry = buildStartupConnectionOptions(connection, { kind: 'keychain-retry' })
    const keychain = buildStartupConnectionOptions(connection, {
      kind: 'keychain', hasNativeConnectionKeepalive: true,
    })

    expect(session).toStrictEqual({
      ...connection,
      disableSmKeepalive: true,
      rememberSession: undefined,
      autoRetryOnTransientFailure: true,
      previouslyJoinedRooms: undefined,
    })
    expect(retry).toStrictEqual({
      ...connection,
      disableSmKeepalive: false,
      rememberSession: true,
      autoRetryOnTransientFailure: true,
    })
    expect(keychain).toStrictEqual({
      ...connection,
      disableSmKeepalive: true,
      rememberSession: true,
    })
    expect(connection).not.toHaveProperty('rememberSession')
  })

  it.each([undefined, 'fallback-password'])('preserves optional FAST credentials (%s)', (password) => {
    const options = buildStartupConnectionOptions({ ...connection, password }, { kind: 'fast-token' })

    expect(options).toStrictEqual({
      ...connection,
      password,
      disableSmKeepalive: false,
      rememberSession: true,
      autoRetryOnTransientFailure: true,
    })
  })
})
