// Lab sender for the FLM-258/FLM-259 proofs. Run with NODE_TLS_REJECT_UNAUTHORIZED=0 (self-signed lab cert).
//   node sender.mjs bookmark          publish alice's autojoin bookmark for lab@conference.localhost (notify all), then exit
//   node sender.mjs run <fifo>        bob goes online and joins the room; each line written to the FIFO is sent:
//                                     "chat <label>" or "CTRL <action>" to alice, "room <label>" to the room.
// Every send is appended to $LAB_DIR/sends.log as: <epoch ms> <iso> <label> <id>
import { createReadStream, appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const LAB_DIR = process.env.LAB_DIR ?? '/tmp/fluux-lab-flm258'
const require = createRequire(new URL('../../../package.json', import.meta.url))
const { client, xml } = await import(pathToFileURL(require.resolve('@xmpp/client')).href)
const ROOM = 'lab@conference.localhost'
const pw = (who) => readFileSync(`${LAB_DIR}/${who}.pw`, 'utf8').trim()
const connect = (username, resource) => {
  const xmpp = client({ service: 'xmpp://127.0.0.1:15222', domain: 'localhost', username, password: pw(username), resource })
  xmpp.on('error', (e) => console.error('xmpp error', e.message))
  return xmpp
}

if (process.argv[2] === 'bookmark') {
  const alice = connect('alice', 'bookmark-setup')
  alice.on('online', async () => {
    const publish = xml('iq', { type: 'set', id: 'bm1' }, xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
      xml('publish', { node: 'urn:xmpp:bookmarks:1' }, xml('item', { id: ROOM },
        xml('conference', { xmlns: 'urn:xmpp:bookmarks:1', name: 'Lab', autojoin: 'true' }, xml('nick', {}, 'alice'),
          xml('extensions', {}, xml('notify', { xmlns: 'urn:xmpp:fluux:0' }, 'all')))
      )),
      xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
        xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
        xml('field', { var: 'pubsub#persist_items' }, xml('value', {}, 'true')),
        xml('field', { var: 'pubsub#max_items' }, xml('value', {}, 'max')),
        xml('field', { var: 'pubsub#send_last_published_item' }, xml('value', {}, 'never')),
        xml('field', { var: 'pubsub#access_model' }, xml('value', {}, 'whitelist'))))))
    const res = await alice.iqCaller.request(publish)
    console.log('bookmark published', res.attrs.type)
    await alice.stop()
  })
  await alice.start()
} else if (process.argv[2] === 'mds') {
  // Print alice's XEP-0490 displayed-marker items (PEP) so a proof can show what Fluux published.
  const alice = connect('alice', 'mds-inspect')
  alice.on('online', async () => {
    const res = await alice.iqCaller.request(xml('iq', { type: 'get', to: 'alice@localhost', id: 'mds1' },
      xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' }, xml('items', { node: 'urn:xmpp:mds:displayed:0' }))))
    for (const item of res.getChild('pubsub', 'http://jabber.org/protocol/pubsub')?.getChild('items')?.getChildren('item') ?? []) {
      const d = item.getChild('displayed', 'urn:xmpp:mds:displayed:0')
      console.log('MDS', item.attrs.id, d?.getChild('stanza-id')?.attrs.id)
    }
    await alice.stop()
  })
  await alice.start()
} else {
  const fifo = process.argv[3]
  const bob = connect('bob', 'sender')
  bob.on('online', async () => {
    await bob.send(xml('presence'))
    await bob.send(xml('presence', { to: `${ROOM}/bob` }, xml('x', { xmlns: 'http://jabber.org/protocol/muc' })))
    console.log('bob online, joined', ROOM)
  })
  await bob.start()
  let n = 0
  for (;;) {
    for await (const line of createInterface({ input: createReadStream(fifo) })) {
      const [kind, ...rest] = line.trim().split(/\s+/)
      if (!kind) continue
      const label = rest.join(' ')
      n++
      const id = `lab-${Date.now()}-${n}`
      const sent = Date.now()
      const body = kind === 'CTRL' ? `CTRL ${label}` : `LAB ${label} sent=${sent}`
      const stanza = kind === 'room'
        ? xml('message', { to: ROOM, type: 'groupchat', id }, xml('body', {}, body))
        : xml('message', { to: 'alice@localhost', type: 'chat', id }, xml('body', {}, body), xml('markable', { xmlns: 'urn:xmpp:chat-markers:0' }))
      await bob.send(stanza)
      appendFileSync(`${LAB_DIR}/sends.log`, `${sent} ${new Date(sent).toISOString()} ${kind} ${label} ${id}\n`)
      console.log('sent', kind, label, id)
    }
  }
}
