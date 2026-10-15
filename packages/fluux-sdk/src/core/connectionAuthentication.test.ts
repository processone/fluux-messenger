import { afterEach, describe, expect, it, vi } from 'vitest'
import { xml } from '@xmpp/client'
import { XMPPClient, bindStoresForTesting } from './XMPPClient'
import { createMockStores } from './test-utils'
import { createInMemoryFastTokenStorage, saveFastToken, fetchFastToken } from './fastTokenStorage'

const JID = 'fixture@example.invalid'
const GOOD = "local-only-ô-Ł-'\"-secret"
const STALE = 'local-only-stale'
const TOKEN = { mechanism: 'HT-SHA-256-NONE', token: 'fixture-token', expiry: '2099-01-01T00:00:00Z' }

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

async function negotiate({ token, acceptToken, password, sasl2 = true }: {
  token: boolean; acceptToken: boolean; password?: string; sasl2?: boolean
}) {
  vi.useFakeTimers()
  const storage = createInMemoryFastTokenStorage()
  if (token) saveFastToken(JID, TOKEN, storage)
  const sdk = new XMPPClient({ debug: false, fastTokenStorage: storage, userAgentId: 'local-fixture' })
  const stores = createMockStores()
  bindStoresForTesting(sdk, stores)
  // Drive the real credentials callback and xmpp.js negotiation without opening a socket.
  const entity = (sdk as any).connection.createXmppClient({
    jid: JID, password, server: 'wss://example.invalid/xmpp', rememberSession: true,
  })
  entity.isSecure = () => true // Model the established WSS transport without opening a socket.
  const attempts: string[] = []
  const errors: any[] = []
  let accepted = false
  const sentPasswords: string[] = []
  entity.on('error', (error: unknown) => errors.push(error))
  entity.send = async (stanza: any) => {
    if (!['authenticate', 'auth'].includes(stanza.name)) return
    entity.emit('send', stanza)
    attempts.push(stanza.attrs.mechanism)
    let valid = acceptToken
    if (stanza.attrs.mechanism === 'PLAIN') {
      const raw = sasl2 ? stanza.getChildText('initial-response') : stanza.text()
      const fields = new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))).split('\0')
      expect(fields[1]).toBe('fixture')
      sentPasswords.push(fields[2])
      valid = fields[2] === GOOD
    }
    queueMicrotask(() => {
      accepted = valid
      const ns = sasl2 ? 'urn:xmpp:sasl:2' : 'urn:ietf:params:xml:ns:xmpp-sasl'
      const reply = valid
        ? xml('success', { xmlns: ns }, ...(sasl2 ? [xml('authorization-identifier', {}, JID)] : []))
        : xml('failure', { xmlns: ns }, xml('not-authorized', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl' }))
      entity.emit('element', reply)
      entity.emit('nonza', reply)
    })
  }
  entity.restart = async () => {}
  entity.emit('element', xml('features', { xmlns: 'http://etherx.jabber.org/streams' },
    xml(sasl2 ? 'authentication' : 'mechanisms', { xmlns: sasl2 ? 'urn:xmpp:sasl:2' : 'urn:ietf:params:xml:ns:xmpp-sasl' },
      xml('mechanism', {}, 'PLAIN'),
      ...(sasl2 ? [xml('inline', {}, xml('fast', { xmlns: 'urn:xmpp:fast:0' }, xml('mechanism', {}, TOKEN.mechanism)))] : []))))
  await vi.waitFor(() => expect(accepted || errors.length > 0).toBe(true))
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const result = { attempts, accepted, sentPasswords, errors, remainingToken: fetchFastToken(JID, storage), authMethod: stores.connection.setAuthMethod.mock.calls.at(-1)?.[0], authMechanism: stores.connection.setAuthMechanism.mock.calls.at(-1)?.[0], logs: stores.console.addEvent.mock.calls.map(call => call[0]) }
  sdk.cancelReconnect()
  return result
}

describe('local socketless iOS/web authentication counterfactuals', () => {
  it('a rejected FAST token falls back to the supplied correct password in the same SASL2 negotiation', async () => {
    const r = await negotiate({ token: true, acceptToken: false, password: GOOD })
    expect(r.attempts).toEqual(['HT-SHA-256-NONE', 'PLAIN'])
    expect(r.accepted).toBe(true)
    expect(r.sentPasswords).toEqual([GOOD])
    expect(r.errors).toEqual([])
    expect(r.remainingToken).toBeNull()
    expect([r.authMethod, r.authMechanism]).toEqual(['password', 'PLAIN'])
    expect(r.logs).toContain('Auth refused: FAST token (SASL: HT-SHA-256-NONE, source: SASL2, condition: not-authorized)')
    expect(r.logs).toContain('Auth succeeded: password (SASL: PLAIN)')
    expect(JSON.stringify(r.logs)).not.toContain(GOOD)
    expect(JSON.stringify(r.logs)).not.toContain(TOKEN.token)
  })
  it('a rejected token plus stale saved password surfaces not-authorized from the password attempt', async () => {
    const r = await negotiate({ token: true, acceptToken: false, password: STALE })
    expect(r.attempts).toEqual(['HT-SHA-256-NONE', 'PLAIN'])
    expect(r.accepted).toBe(false)
    expect(r.errors[0].condition).toBe('not-authorized')
    expect(r.remainingToken).toBeNull()
    expect(r.logs).toContain('Auth refused: password (SASL: PLAIN, source: SASL2, condition: not-authorized)')
  })
  it('a working FAST token masks a stale password, matching a possible successful web path', async () => {
    const r = await negotiate({ token: true, acceptToken: true, password: STALE })
    expect(r.attempts).toEqual(['HT-SHA-256-NONE'])
    expect(r.accepted).toBe(true)
    expect(r.sentPasswords).toEqual([])
    expect([r.authMethod, r.authMechanism]).toEqual(['fast-token', 'HT-SHA-256-NONE'])
    expect(r.logs).toContain('Auth succeeded: FAST token (SASL: HT-SHA-256-NONE)')
  })
  it('correct password succeeds without a token under SASL2 and preserves Unicode', async () => {
    const r = await negotiate({ token: false, acceptToken: false, password: GOOD })
    expect(r.attempts).toEqual(['PLAIN'])
    expect(r.accepted).toBe(true)
    expect(r.sentPasswords).toEqual([GOOD])
  })
  it('the same correct Unicode password succeeds over legacy SASL', async () => {
    const r = await negotiate({ token: false, acceptToken: false, password: GOOD, sasl2: false })
    expect(r.attempts).toEqual(['PLAIN'])
    expect(r.accepted).toBe(true)
    expect(r.sentPasswords).toEqual([GOOD])
  })
})
