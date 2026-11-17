import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { OmemoAccount, MemoryStore, b64decode, b64encode } from '../index'

// Tagged interop harness vs the python-omemo (`OMEMO` + `twomemo`) reference stack.
// Excluded from the default unit run; the package vitest config only includes
// `interop/**` when VITEST_INTEROP=1. Requires a running docker peer container:
//
//   cd packages/omemo/src/interop && docker compose up -d
//   VITEST_INTEROP=1 npx vitest run packages/omemo/src/interop/interop.test.ts
//
// SCOPE (see README.md): this exercises the crypto-transport layers -- X3DH from our
// bundle, the Double Ratchet, the OMEMO 2 protobuf wire format, the 48-byte payload-key
// transport and the AES-256-CBC "OMEMO Payload" cipher. `@fluux/omemo` is now content-agnostic:
// `encrypt` transports opaque `content` bytes verbatim, so the reference recovers exactly those
// bytes. A body-level test against a strict XEP-0420 SCE reference is a follow-up for the SDK
// adapter layer, not this crypto core.

const HERE = new URL('.', import.meta.url).pathname
const SHARED = HERE + 'shared/'

const run = (...args: string[]) =>
  execFileSync('docker', ['compose', 'exec', '-T', 'omemo-peer', 'python', '/peer/omemo_peer.py', ...args], {
    cwd: HERE,
  })

const rng = (n: number) => webcrypto.getRandomValues(new Uint8Array(n))

describe.runIf(process.env.VITEST_INTEROP)('OMEMO 2 interop with python-omemo', () => {
  beforeAll(() => mkdirSync(SHARED, { recursive: true }))

  it('the reference peer establishes a session from our bundle and recovers our payload', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), rng)

    // 1. The reference peer publishes an OMEMO 2 bundle.
    run('gen-bundle')
    const pb = JSON.parse(readFileSync(SHARED + 'bundle.json', 'utf8'))

    // 2. We run X3DH against it (initiator side) and encrypt a message.
    await alice.processBundle('peer@local', pb.deviceId, {
      ik: b64decode(pb.ik),
      spkId: pb.spkId,
      spk: b64decode(pb.spk),
      spkSig: b64decode(pb.spkSig),
      preKeys: pb.preKeys.map((p: { id: number; key: string }) => ({ id: p.id, key: b64decode(p.key) })),
    })
    const content = new TextEncoder().encode('interop hello')
    const msg = await alice.encrypt([{ jid: 'peer@local', deviceIds: [pb.deviceId] }], content)

    // 3. Ship the OmemoMessage as JSON (base64 of the real protobuf `key` bytes + payload).
    writeFileSync(
      SHARED + 'msg.json',
      JSON.stringify({
        sid: msg.sid,
        payload: msg.payload ? b64encode(msg.payload) : null,
        keys: msg.keys.map((k) => ({ jid: k.jid, rid: k.rid, kex: k.kex, data: b64encode(k.data) })),
      }),
    )

    // 4. The reference decrypts and writes the RAW recovered payload bytes (base64).
    //    A successful, throw-free decrypt already proves every crypto-transport layer
    //    interops (X3DH + Double Ratchet + wire protobuf + payload-key + AES-256-CBC).
    run('decrypt', '/shared/msg.json')
    const recovered = b64decode(readFileSync(SHARED + 'plaintext.b64', 'utf8').trim())

    // 5. `encrypt` is content-agnostic: the reference recovers our opaque content bytes verbatim.
    expect(recovered).toEqual(content)
  })
})
