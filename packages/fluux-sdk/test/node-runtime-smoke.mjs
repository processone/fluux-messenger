import assert from 'node:assert/strict'
import test from 'node:test'

Object.defineProperty(globalThis, 'localStorage', {
  value: undefined,
  configurable: true,
})

const {
  XMPPClient,
  createInMemoryFastTokenStorage,
  setLogSink,
} = await import('../dist/core/index.js')

setLogSink(() => {})

function exerciseFastHooks(fastTokenStorage) {
  const sdkClient = new XMPPClient({ fastTokenStorage })
  const xmppClient = sdkClient.connection.createXmppClient({
    jid: 'bot@example.com',
    password: 'secret',
    server: 'wss://example.com/ws',
    rememberSession: true,
  })

  assert.equal(xmppClient.fast.fetchToken(), null)
  xmppClient.fast.saveToken({
    mechanism: 'HT-SHA-256-NONE',
    token: 'node-token',
  })
  assert.equal(xmppClient.fast.fetchToken()?.token, 'node-token')
  xmppClient.fast.deleteToken()
  assert.equal(xmppClient.fast.fetchToken(), null)

  sdkClient.destroy()
}

test('the core client FAST hooks run without browser globals', () => {
  exerciseFastHooks(undefined)
})

test('the core client uses an injected FAST token storage adapter', () => {
  exerciseFastHooks(createInMemoryFastTokenStorage())
})
