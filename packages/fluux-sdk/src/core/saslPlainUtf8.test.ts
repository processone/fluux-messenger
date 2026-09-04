/**
 * What SASL PLAIN puts on the wire (#1219).
 *
 * These drive a real `@xmpp/client` and read the base64 out of the `<auth/>`
 * stanza the library itself builds, rather than calling our mechanism directly:
 * the point is the bytes that reach the server, through the library's own
 * mechanism selection and its own base64 step. The expected byte strings below
 * are the ones measured against ejabberd 26.7.0, where the UTF-8 form
 * authenticates and the latin-1 form is answered with `not-authorized`.
 */
import { describe, it, expect } from 'vitest'
import { client, xml, type Element } from '@xmpp/client'
import { installUtf8SaslPlain } from './saslPlainUtf8'

const USERNAME = 'alice'
/** The reporter's password shape: `ô` is U+00F4, inside btoa()'s latin-1 range. */
const ACCENTED = 'aeztKehsdlanalfô91'
/** `Ł` is U+0141, above that range, where btoa() throws instead of mangling. */
const ABOVE_LATIN1 = 'aeztKehsdlanalfŁ91'
/** Deliberately decomposed: this encoding fix must not apply SASLprep or normalization. */
const DECOMPOSED = 'aeztKehsdlanalfo\u030291'

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function utf8Hex(text: string): string {
  return toHex(new TextEncoder().encode(text))
}

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0))
}

/**
 * Run the library's SASL negotiation far enough to capture the `<auth/>` it
 * sends, without a socket: `<stream:features>` goes in as an incoming element
 * and the outgoing stanza is intercepted at `send`.
 */
async function captureAuthStanza(options: {
  password: string
  install: boolean
}): Promise<Element> {
  const xmppClient = client({
    service: 'wss://example.invalid/ws',
    domain: 'example.invalid',
    username: USERNAME,
    credentials: async (authenticate) => {
      await authenticate({ username: USERNAME, password: options.password }, 'PLAIN')
    },
  })

  if (options.install) installUtf8SaslPlain(xmppClient)

  let captured: (element: Element) => void = () => {}
  const sent = new Promise<Element>((resolve) => {
    captured = resolve
  })
  let failed: (error: unknown) => void = () => {}
  const errored = new Promise<never>((_, reject) => {
    failed = reject
  })

  xmppClient.send = async (element: Element) => captured(element)
  // The SASL layer routes a mechanism that throws into the entity's error event.
  xmppClient.on('error', (error) => failed(error))

  // The client is an EventEmitter underneath; `emit` is not on the SDK-facing
  // declaration because nothing in the SDK should be injecting stream elements.
  const emitter = xmppClient as unknown as { emit: (event: string, element: Element) => void }
  emitter.emit('element', xml(
    'features',
    { xmlns: 'http://etherx.jabber.org/streams' },
    xml('mechanisms', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl' }, xml('mechanism', {}, 'PLAIN'))
  ))

  return Promise.race([sent, errored])
}

async function captureAuthBytes(options: {
  password: string
  install: boolean
}): Promise<Uint8Array> {
  const auth = await captureAuthStanza(options)
  expect(auth.name).toBe('auth')
  expect(auth.attrs.mechanism).toBe('PLAIN')
  return decodeBase64(auth.text())
}

describe('SASL PLAIN wire encoding', () => {
  it('sends an accented password as UTF-8', async () => {
    const bytes = await captureAuthBytes({ password: ACCENTED, install: true })

    expect(toHex(bytes)).toBe(utf8Hex(`\0${USERNAME}\0${ACCENTED}`))
    // Spelled out so the assertion is anchored on the bytes ejabberd accepted,
    // not on a second call to the encoder under test: `ô` is c3 b4, not f4.
    expect(toHex(bytes)).toBe('00616c6963650061657a744b656873646c616e616c66c3b43931')
  })

  it('sends a password above U+00FF instead of throwing', async () => {
    const bytes = await captureAuthBytes({ password: ABOVE_LATIN1, install: true })

    expect(toHex(bytes)).toBe(utf8Hex(`\0${USERNAME}\0${ABOVE_LATIN1}`))
  })

  it('leaves an ASCII password byte-for-byte unchanged', async () => {
    const bytes = await captureAuthBytes({ password: 'aeztKehsdlanalfo91', install: true })

    expect(toHex(bytes)).toBe(utf8Hex(`\0${USERNAME}\0aeztKehsdlanalfo91`))
  })

  it('preserves a non-normalized password byte-for-byte', async () => {
    const bytes = await captureAuthBytes({ password: DECOMPOSED, install: true })

    expect(toHex(bytes)).toBe(utf8Hex(`\0${USERNAME}\0${DECOMPOSED}`))
    expect(toHex(bytes)).not.toBe(utf8Hex(`\0${USERNAME}\0${ACCENTED}`))
  })

  describe('without the patch', () => {
    /**
     * These two pin the defect the patch exists for, so its cost stays visible.
     * If either starts failing, xmpp.js has fixed PLAIN upstream and this whole
     * module — patch, install calls, and these tests — should be deleted.
     */
    it('mangles an accented password to latin-1', async () => {
      const bytes = await captureAuthBytes({ password: ACCENTED, install: false })

      expect(toHex(bytes)).toBe('00616c6963650061657a744b656873646c616e616c66f43931')
      expect(toHex(bytes)).not.toBe(utf8Hex(`\0${USERNAME}\0${ACCENTED}`))
    })

    it('throws on a password above U+00FF', async () => {
      await expect(
        captureAuthBytes({ password: ABOVE_LATIN1, install: false })
      ).rejects.toThrow(/latin1|Latin1|character/i)
    })
  })

  describe('installUtf8SaslPlain', () => {
    it('leaves a client alone when no PLAIN mechanism is registered', () => {
      const withoutPlain = {
        saslFactory: { _mechs: [{ name: 'SCRAM-SHA-1', mech: class {} }], create: () => null },
      }

      expect(() =>
        installUtf8SaslPlain(withoutPlain as unknown as Parameters<typeof installUtf8SaslPlain>[0])
      ).not.toThrow()
      expect(withoutPlain.saslFactory._mechs).toHaveLength(1)
      expect(withoutPlain.saslFactory._mechs[0].name).toBe('SCRAM-SHA-1')
    })
  })
})
