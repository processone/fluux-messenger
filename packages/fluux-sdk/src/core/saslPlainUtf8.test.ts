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
  sasl2: boolean
  username?: string
  authzid?: string
}): Promise<Element> {
  const xmppClient = client({
    service: 'wss://example.invalid/ws',
    domain: 'example.invalid',
    username: USERNAME,
    credentials: async (authenticate) => {
      await authenticate({ username: options.username ?? USERNAME, password: options.password, authzid: options.authzid }, 'PLAIN')
    },
  })

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
    xml(options.sasl2 ? 'authentication' : 'mechanisms', {
      xmlns: options.sasl2 ? 'urn:xmpp:sasl:2' : 'urn:ietf:params:xml:ns:xmpp-sasl',
    }, xml('mechanism', {}, 'PLAIN'))
  ))

  return Promise.race([sent, errored])
}

async function captureAuthBytes(options: {
  password: string
  sasl2: boolean
  username?: string
  authzid?: string
}): Promise<Uint8Array> {
  const auth = await captureAuthStanza(options)
  expect(auth.name).toBe(options.sasl2 ? 'authenticate' : 'auth')
  expect(auth.attrs.mechanism).toBe('PLAIN')
  return decodeBase64(options.sasl2 ? auth.getChildText('initial-response')! : auth.text())
}

describe.each([false, true])('SASL PLAIN wire encoding (SASL2: %s)', (sasl2) => {
  it('sends an accented password as UTF-8', async () => {
    const bytes = await captureAuthBytes({ password: ACCENTED, sasl2 })

    expect(toHex(bytes)).toBe(utf8Hex(`\0${USERNAME}\0${ACCENTED}`))
    // Spelled out so the assertion is anchored on the bytes ejabberd accepted,
    // not on a second call to the encoder under test: `ô` is c3 b4, not f4.
    expect(toHex(bytes)).toBe('00616c6963650061657a744b656873646c616e616c66c3b43931')
  })

  it('sends a password above U+00FF instead of throwing', async () => {
    const bytes = await captureAuthBytes({ password: ABOVE_LATIN1, sasl2 })

    expect(toHex(bytes)).toBe(utf8Hex(`\0${USERNAME}\0${ABOVE_LATIN1}`))
  })

  it('leaves an ASCII password byte-for-byte unchanged', async () => {
    const bytes = await captureAuthBytes({ password: 'aeztKehsdlanalfo91', sasl2 })

    expect(toHex(bytes)).toBe(utf8Hex(`\0${USERNAME}\0aeztKehsdlanalfo91`))
  })

  it('preserves a non-normalized password byte-for-byte', async () => {
    const bytes = await captureAuthBytes({ password: DECOMPOSED, sasl2 })

    expect(toHex(bytes)).toBe(utf8Hex(`\0${USERNAME}\0${DECOMPOSED}`))
    expect(toHex(bytes)).not.toBe(utf8Hex(`\0${USERNAME}\0${ACCENTED}`))
  })

  it('encodes the authorization identity and username as UTF-8 too', async () => {
    const bytes = await captureAuthBytes({
      password: 'secret', username: 'élise', authzid: 'élise@example.com', sasl2,
    })

    expect(toHex(bytes)).toBe(utf8Hex('élise@example.com\0élise\0secret'))
  })

  it('encodes supplementary Unicode characters', async () => {
    const bytes = await captureAuthBytes({ password: 'test🔑', sasl2 })

    expect(toHex(bytes)).toBe('00616c6963650074657374f09f9491')
  })
})
