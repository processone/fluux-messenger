import assert from 'node:assert/strict'
import saslPlain from '@xmpp/sasl-plain'
import { encode, decode } from '@xmpp/base64'

// A patch may still apply when another xmpp.js package changes its byte contract.
let Plain
saslPlain({ use: (mechanism) => { Plain = mechanism } })
const response = new Plain().response({ username: 'install-check', password: '\u00f4\u0141' })
assert.deepEqual(
  Buffer.from(encode(response), 'base64'),
  Buffer.from('\0install-check\0\u00f4\u0141', 'utf8'),
  'SASL PLAIN must send UTF-8: review patches/@xmpp+sasl-plain+0.14.0.patch before building',
)

// FAST mechanisms pass binary signatures through the same base64 functions.
const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
const binary = bytes.toString('latin1')
assert.deepEqual(Buffer.from(encode(binary), 'base64'), bytes, '@xmpp/base64 must preserve binary SASL responses')
assert.equal(decode(bytes.toString('base64')), binary, '@xmpp/base64 must preserve binary SASL challenges')

console.log('XMPP SASL encoding checks passed')
