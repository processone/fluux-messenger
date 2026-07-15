// Alice (our @fluux/omemo lib) encrypts to Bob's REFERENCE-generated bundle.
// Reads <RUN>/bob_bundle.json (produced by interop_decrypt.py), writes <RUN>/our_msg.json.
// Usage: node emit_to_bob.mjs <RUN_DIR>   (normally invoked by interop_decrypt.py)
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Resolve the built library relative to this file: src/interop/venv -> packages/omemo/dist
import { OmemoAccount, MemoryStore, b64encode, b64decode } from '../../../dist/index.js'

const runDir = process.argv[2]
if (!runDir) {
  console.error('usage: node emit_to_bob.mjs <RUN_DIR>')
  process.exit(2)
}
const rng = (n) => crypto.getRandomValues(new Uint8Array(n))

const bob = JSON.parse(readFileSync(join(runDir, 'bob_bundle.json'), 'utf8'))

const alice = await OmemoAccount.create(new MemoryStore(), rng)

// Reconstruct Bob's bundle in the shape processBundle expects (verifies spkSig against ik).
const bobBundle = {
  ik: b64decode(bob.ik),
  spkId: bob.spkId,
  spk: b64decode(bob.spk),
  spkSig: b64decode(bob.spkSig),
  preKeys: bob.preKeys.map((p) => ({ id: p.id, key: b64decode(p.key) })),
}
await alice.processBundle('bob@localhost', bob.deviceId, bobBundle)

const plaintext = 'interop hello from @fluux/omemo'
const msg = await alice.encrypt('bob@localhost', [bob.deviceId], new TextEncoder().encode(plaintext))

// Alice's own publishable bundle, so the reference can learn Alice's identity key.
const aliceBundle = await alice.publishableBundleAsync()

const out = {
  plaintext,
  alice: {
    deviceId: alice.publishableDeviceId(),
    ik: b64encode(aliceBundle.ik),
    spkId: aliceBundle.spkId,
    spk: b64encode(aliceBundle.spk),
    spkSig: b64encode(aliceBundle.spkSig),
    preKeys: aliceBundle.preKeys.slice(0, 5).map((p) => ({ id: p.id, key: b64encode(p.key) })),
  },
  message: {
    sid: msg.sid,
    payload: msg.payload ? b64encode(msg.payload) : null,
    payloadLen: msg.payload ? msg.payload.length : 0,
    keys: msg.keys.map((k) => ({ rid: k.rid, kex: k.kex, data: b64encode(k.data) })),
  },
}
writeFileSync(join(runDir, 'our_msg.json'), JSON.stringify(out, null, 2))
console.log(
  'emitted our_msg.json: sid=%d payloadLen=%d keys=%d aliceSid=%d bobDev=%d',
  msg.sid, out.message.payloadLen, msg.keys.length, out.alice.deviceId, bob.deviceId,
)
