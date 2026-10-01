// Sends one test notification straight to APNs, bypassing ejabberd.
//
// Usage:
//   node scripts/apns-test.mjs <AuthKey_XXXXXXXXXX.p8> <KEY_ID> <DEVICE_TOKEN> [development|production]
//
// Team 8L55BDM864, topic net.processone.fluux. The key never leaves this machine.
import { readFileSync } from 'node:fs'
import { sign } from 'node:crypto'
import http2 from 'node:http2'

const [keyPath, keyId, token, environment = 'development'] = process.argv.slice(2)
if (!keyPath || !keyId || !token) {
  console.error('usage: node scripts/apns-test.mjs <key.p8> <KEY_ID> <DEVICE_TOKEN> [development|production]')
  process.exit(1)
}

const b64url = (value) => Buffer.from(value).toString('base64url')
const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
const claims = b64url(JSON.stringify({ iss: '8L55BDM864', iat: Math.floor(Date.now() / 1000) }))
const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
  key: readFileSync(keyPath),
  dsaEncoding: 'ieee-p1363',
}).toString('base64url')

const host = environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com'
const client = http2.connect(host)
const request = client.request({
  ':method': 'POST',
  ':path': `/3/device/${token}`,
  authorization: `bearer ${header}.${claims}.${signature}`,
  'apns-topic': 'net.processone.fluux',
  'apns-push-type': 'alert',
  'content-type': 'application/json',
})
let body = ''
request.on('response', (headers) => console.log(`APNs ${environment}: HTTP ${headers[':status']}`))
request.on('data', (chunk) => { body += chunk })
request.on('end', () => {
  if (body) console.log(body)
  client.close()
})
request.end(JSON.stringify({ aps: { alert: { title: 'Fluux', body: 'Test push via APNs' }, sound: 'default' } }))
