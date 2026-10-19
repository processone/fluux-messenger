#!/usr/bin/env node
// Development helper: sends one OpenPGP (XEP-0373/0374) encrypted chat message to a recipient,
// so the iOS notification preview path can be exercised without a second person.
//
//   node scripts/ox-test-sender.mjs <recipient-bare-jid> [text]
//
// The sender account comes from OX_BOT_JID. Its password is read from the macOS keychain
// (service "fluux-ox-bot", account = the bot JID), added once with:
//   security add-generic-password -s fluux-ox-bot -a <bot-jid> -w
// The bot's private key is generated on first use and kept outside the repository, in
// ~/.fluux-ox-bot/<bot-jid>.json. OX_BOT_SERVICE overrides the connection URI.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveSrv } from 'node:dns/promises'
import { client, xml } from '@xmpp/client'
import * as openpgp from 'openpgp'

const NS_OX = 'urn:xmpp:openpgp:0'
const KEYS_LIST_NODE = `${NS_OX}:public-keys`

const recipient = process.argv[2]
const text = process.argv[3] ?? `OX test ${new Date().toLocaleTimeString()}`
const botJid = process.env.OX_BOT_JID
if (!recipient || !botJid) {
  console.error('usage: OX_BOT_JID=<bot-jid> node scripts/ox-test-sender.mjs <recipient-jid> [text]')
  process.exit(2)
}
const [username, domain] = botJid.split('@')
const password = execFileSync('security', ['find-generic-password', '-s', 'fluux-ox-bot', '-a', botJid, '-w'], { encoding: 'utf8' }).trim()

const dearmor = async (armored, read) => Buffer.from((await read(armored)).write()).toString('base64')
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;')
const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function loadOrCreateKey() {
  const dir = join(homedir(), '.fluux-ox-bot')
  const file = join(dir, `${botJid}.json`)
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')), created: false }
  const { privateKey, publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ name: `xmpp:${botJid}` }], format: 'armored' })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ privateKey, publicKey }), { mode: 0o600 })
  return { privateKey, publicKey, created: true }
}

function publishOptions(fields) {
  return xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    ...Object.entries(fields).map(([k, v]) => xml('field', { var: `pubsub#${k}` }, xml('value', {}, v)))))
}

async function publishKey(iq, publicKey) {
  const key = await openpgp.readKey({ armoredKey: publicKey })
  const fingerprint = key.getFingerprint().toUpperCase()
  const date = key.getCreationTime().toISOString()
  const options = { access_model: 'open', persist_items: 'true', max_items: '1' }
  await iq.set(xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
    xml('publish', { node: `${KEYS_LIST_NODE}:${fingerprint}` },
      xml('item', { id: date }, xml('pubkey', { xmlns: NS_OX }, xml('data', {}, await dearmor(publicKey, (a) => openpgp.readKey({ armoredKey: a })))))),
    publishOptions(options)))
  await iq.set(xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
    xml('publish', { node: KEYS_LIST_NODE },
      xml('item', { id: 'current' }, xml('public-keys-list', { xmlns: NS_OX }, xml('pubkey-metadata', { 'v4-fingerprint': fingerprint, date })))),
    publishOptions(options)))
  return fingerprint
}

async function fetchItems(iq, jid, node) {
  const res = await iq.get(xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' }, xml('items', { node, max_items: '1' })), jid)
  return res.getChild('items')?.getChildren('item') ?? []
}

async function fetchPublicKeys(iq, jid) {
  const [list] = await fetchItems(iq, jid, KEYS_LIST_NODE)
  const fingerprints = list?.getChild('public-keys-list', NS_OX)?.getChildren('pubkey-metadata').map((m) => m.attrs['v4-fingerprint']) ?? []
  const keys = []
  for (const fingerprint of fingerprints) {
    const [item] = await fetchItems(iq, jid, `${KEYS_LIST_NODE}:${fingerprint}`)
    const data = item?.getChild('pubkey', NS_OX)?.getChildText('data')
    if (data) keys.push(await openpgp.readKey({ binaryKey: Buffer.from(data.trim(), 'base64') }))
  }
  if (keys.length === 0) throw new Error(`no OpenPGP key published by ${jid}`)
  return keys
}

const { privateKey: armoredPrivate, publicKey, created } = await loadOrCreateKey()
const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivate })
// RFC 6120 §3.2.1: the client endpoint comes from the domain's SRV record.
const srv = await resolveSrv(`_xmpp-client._tcp.${domain}`).then((records) => records[0]).catch(() => null)
const service = process.env.OX_BOT_SERVICE ?? (srv ? `xmpp://${srv.name}:${srv.port}` : `xmpp://${domain}`)
const xmpp = client({ service, domain, username, password, resource: 'ox-test-sender' })
xmpp.on('error', (err) => console.error('xmpp error:', err.message))

await xmpp.start()
const iq = xmpp.iqCaller
const fingerprint = await publishKey(iq, publicKey)
console.log(`${created ? 'generated and published' : 'published'} bot key ${fingerprint}`)
const recipientKeys = await fetchPublicKeys(iq, recipient)

const rpad = randomBytes(1 + Math.floor(Math.random() * 64)).toString('base64')
const signcrypt = `<signcrypt xmlns='${NS_OX}'><to jid='${escapeAttr(recipient)}'/><time stamp='${new Date().toISOString()}'/>` +
  `<rpad>${rpad}</rpad><payload xmlns='jabber:client'><body>${escapeText(text)}</body></payload></signcrypt>`
const encrypted = await openpgp.encrypt({
  message: await openpgp.createMessage({ text: signcrypt }),
  encryptionKeys: [...recipientKeys, privateKey.toPublic()],
  signingKeys: privateKey,
  format: 'binary',
})
const id = `ox-test-${randomBytes(6).toString('hex')}`
await xmpp.send(xml('message', { to: recipient, type: 'chat', id },
  xml('openpgp', { xmlns: NS_OX }, Buffer.from(encrypted).toString('base64')),
  xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: NS_OX }),
  xml('body', {}, 'This message is encrypted with OpenPGP (XEP-0373).'),
  xml('store', { xmlns: 'urn:xmpp:hints' })))
console.log(`sent ${id} to ${recipient} (${recipientKeys.length} recipient key${recipientKeys.length > 1 ? 's' : ''})`)
await xmpp.stop()
