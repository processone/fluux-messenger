// Body-level interop gate: prove the `twomemo` reference decrypts a full
// `<encrypted>` stanza built by our `OmemoPlugin` AND parses the XEP-0420 SCE
// envelope to recover the EXACT message body. This is the M2a "done" bar.
//
// Gated behind VITEST_INTEROP so the default suite never spawns the python
// reference. Run with:
//   VITEST_INTEROP=1 npx vitest run packages/omemo-plugin/src/interop/plugin_interop.test.ts
//
// Flow (three real hops, no mocking of the crypto):
//   1. reference (Bob) generates its OMEMO 2 bundle + persists its storage
//      (interop_gen_bundle.py).
//   2. the PLUGIN (Alice) encrypts a real <body> to Bob's bundle IN-PROCESS,
//      producing a genuine <encrypted xmlns='urn:xmpp:omemo:2'> stanza.
//   3. the reference reloads Bob, decrypts the plugin stanza, and independently
//      parses the recovered bytes as urn:xmpp:sce:1 to recover the <body>
//      (interop_decrypt_plugin.py).
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { xml } from '@xmpp/client'
import { serializePayloadEnvelope } from '@fluux/sdk'
import { b64encode, b64decode } from '@fluux/omemo'
import type { Bundle } from '@fluux/omemo'
import { OmemoPlugin } from '../OmemoPlugin'
import { createMockPluginContext, seedPeer } from '../testing/MockPluginContext'
import { deviceListToXml, bundleToXml, fetchBundle } from '../pep'
import { elementToData, dataToElement } from '../stanzaData'
import { devicesNode, bundleNode } from '../namespaces'
import type { XMLElementData } from '@fluux/sdk'

const EXPECTED_BODY = 'interop hello from plugin'
const HERE = new URL('.', import.meta.url).pathname
const RUN = `${HERE}_run`
const VENV = new URL('../../../omemo/src/interop/venv/', import.meta.url).pathname
const PY = `${VENV}_run/venv/bin/python`

describe.runIf(process.env.VITEST_INTEROP)('plugin body-level interop vs twomemo', () => {
  beforeAll(() => mkdirSync(RUN, { recursive: true }))

  it('twomemo decrypts a plugin <encrypted> and recovers the body via SCE', async () => {
    const bundlePath = `${RUN}/bob_bundle.json`

    // 1) Reference generates Bob's bundle (and persists Bob's storage alongside).
    execFileSync(PY, [`${VENV}interop_gen_bundle.py`, bundlePath], { encoding: 'utf8' })
    const bob = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
      deviceId: number
      ik: string
      spkId: number
      spk: string
      spkSig: string
      preKeys: Array<{ id: number; key: string }>
    }

    // 2) Drive the PLUGIN (Alice) in-process. Seed Bob's device-list + bundle
    //    into Alice's mock PEP so the plugin's fetchDeviceList/fetchBundle find them.
    const { ctx, net } = createMockPluginContext('alice@localhost')
    const bobBundle: Bundle = {
      ik: b64decode(bob.ik),
      spkId: bob.spkId,
      spk: b64decode(bob.spk),
      spkSig: b64decode(bob.spkSig),
      preKeys: bob.preKeys.map((p) => ({ id: p.id, key: b64decode(p.key) })),
    }
    seedPeer(net, 'bob@localhost', devicesNode(), elementToData(deviceListToXml([bob.deviceId])))
    seedPeer(net, 'bob@localhost', bundleNode(bob.deviceId), elementToData(bundleToXml(bobBundle)))

    const plugin = new OmemoPlugin()
    await plugin.init(ctx)
    const identity = await plugin.ensureIdentity()
    const handle = await plugin.openConversation({ kind: 'direct', peer: 'bob@localhost' })

    const payload = new TextEncoder().encode(
      serializePayloadEnvelope([xml('body', { xmlns: 'jabber:client' }, EXPECTED_BODY)]),
    )
    const enc = await plugin.encrypt(handle, payload)

    // Serialize the plugin's <encrypted> element to real XML for the reference.
    const encryptedXml = dataToElement(enc.stanzaElement as XMLElementData).toString()

    // The reference needs Alice's bundle to register her as a known sender.
    const aliceDevId = identity.devices?.[0]?.deviceId
    if (!aliceDevId) throw new Error('ensureIdentity did not report a device id')
    const aliceDev = Number(aliceDevId)
    const aliceBundle = await fetchBundle(ctx.xmpp, 'alice@localhost', aliceDev)
    if (!aliceBundle) throw new Error('alice bundle not found in mock PEP after ensureIdentity')

    writeFileSync(
      `${RUN}/plugin_msg.json`,
      JSON.stringify({
        senderJid: 'alice@localhost',
        alice: {
          deviceId: aliceDev,
          ik: b64encode(aliceBundle.ik),
          spkId: aliceBundle.spkId,
          spk: b64encode(aliceBundle.spk),
          spkSig: b64encode(aliceBundle.spkSig),
          preKeys: aliceBundle.preKeys.slice(0, 5).map((p) => ({ id: p.id, key: b64encode(p.key) })),
        },
        encryptedXml,
      }),
    )

    // 3) Reference decrypts the plugin <encrypted> and parses the SCE envelope.
    const out = execFileSync(PY, [`${VENV}interop_decrypt_plugin.py`, `${RUN}/plugin_msg.json`, bundlePath], {
      encoding: 'utf8',
    })

    expect(out).toContain(`RECOVERED_BODY: ${EXPECTED_BODY}`)
    expect(out).toContain('BODY INTEROP SUCCESS')
  }, 60_000)
})
