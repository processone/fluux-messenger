// Push spike scenario 11: send an alert straight to APNs, bypassing the XMPP server and push.fluux.io.
// Usage: APNS_KEY_FILE=AuthKey_XXXX.p8 APNS_KEY_ID=XXXX APNS_TEAM_ID=TEAMID \
//        node apns-direct.mjs <device-token-hex> [production|development] [text]
// The .p8 key is read from the path in APNS_KEY_FILE; the key never goes on the command line.
import { createPrivateKey, createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect } from 'node:http2'

const TOPIC = 'net.processone.fluux'
const b64url = value => Buffer.from(value).toString('base64url')

export function providerToken(keyPem, keyId, teamId, now = Math.floor(Date.now() / 1000)) {
  const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64url(JSON.stringify({ iss: teamId, iat: now }))}`
  const signature = createSign('SHA256').update(input).sign({ key: createPrivateKey(keyPem), dsaEncoding: 'ieee-p1363' })
  return `${input}.${signature.toString('base64url')}`
}

// Priority 10 with a nonzero expiration: with expiration 0 Apple drops a push for a sleeping Mac.
export function request(token, environment, text, jwt, now = Math.floor(Date.now() / 1000)) {
  const host = environment === 'development' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'
  return {
    host,
    path: `/3/device/${token}`,
    headers: {
      ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${jwt}`,
      'apns-topic': TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(now + 3600),
    },
    body: JSON.stringify({ aps: { alert: { title: 'Direct APNs spike', body: text }, sound: 'default' } }),
  }
}

async function main() {
  const [token, environment = 'production', text = `spike ${new Date().toISOString()}`] = process.argv.slice(2)
  const { APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID } = process.env
  if (!token || !/^[0-9a-f]+$/i.test(token) || !APNS_KEY_FILE || !APNS_KEY_ID || !APNS_TEAM_ID) {
    console.error('Usage: APNS_KEY_FILE, APNS_KEY_ID and APNS_TEAM_ID in the environment; node apns-direct.mjs <token-hex> [production|development] [text]')
    process.exit(2)
  }
  const sentAt = Date.now()
  const req = request(token, environment, text, providerToken(readFileSync(APNS_KEY_FILE, 'utf8'), APNS_KEY_ID, APNS_TEAM_ID))
  const session = connect(`https://${req.host}`)
  const stream = session.request(req.headers)
  let status = 0, body = '', apnsId = ''
  stream.on('response', headers => { status = headers[':status']; apnsId = headers['apns-id'] ?? '' })
  stream.on('data', chunk => { body += chunk })
  stream.on('end', () => {
    session.close()
    console.log(JSON.stringify({ sentAtMs: sentAt, status, apnsId, body }))
    process.exitCode = status === 200 ? 0 : 1
  })
  stream.end(req.body)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
