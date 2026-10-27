// @vitest-environment node
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script
import { providerToken, request } from './apns-direct.mjs'

// FLM-188 scenario 11: the direct send must match what the gateway sends, or it proves nothing.
describe('direct APNs send', () => {
  it('signs a verifiable ES256 provider token', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwt = providerToken(privateKey.export({ type: 'pkcs8', format: 'pem' }), 'KEYID12345', 'TEAMID1234', 1000)
    const [header, claims, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEYID12345' })
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iss: 'TEAMID1234', iat: 1000 })
    const ok = createVerify('SHA256').update(`${header}.${claims}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
    expect(ok).toBe(true)
  })

  it('sends priority 10 with a nonzero expiration to the Fluux topic', () => {
    const req = request('ab12', 'production', 'hi', 'jwt', 1000)
    expect(req.host).toBe('api.push.apple.com')
    expect(req.headers).toMatchObject({ 'apns-topic': 'net.processone.fluux', 'apns-priority': '10', 'apns-expiration': '4600', 'apns-push-type': 'alert' })
  })
})
