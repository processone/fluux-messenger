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
// transport and the AES-256-CBC "OMEMO Payload" cipher. The reference *cannot* interpret
// our SCE envelope (sce.ts emits a placeholder byte format, not XEP-0420 XML), so the peer
// hands back the RAW recovered payload bytes and this test does the Fluux-format field-walk
// to pull out the body. A body-level test against a strict XEP-0420 reference is a follow-up
// for the SDK adapter layer, not this crypto core.

const HERE = new URL('.', import.meta.url).pathname
const SHARED = HERE + 'shared/'

const run = (...args: string[]) =>
  execFileSync('docker', ['compose', 'exec', '-T', 'omemo-peer', 'python', '/peer/omemo_peer.py', ...args], {
    cwd: HERE,
  })

const rng = (n: number) => webcrypto.getRandomValues(new Uint8Array(n))

// Minimal reader for sce.ts's placeholder envelope format: a stream of
// [u32be tagLen][tag][u32be valLen][val] fields. Extracts the `body` field. This mirrors
// parseEnvelope() (which is intentionally not part of the public API) so the harness can
// interpret the bytes the reference recovered without leaking that format into the peer.
function readEnvelopeBody(bytes: Uint8Array): string | undefined {
  const dec = new TextDecoder()
  let off = 0
  const u32 = () => {
    const v = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0
    off += 4
    return v
  }
  while (off < bytes.length) {
    const tagLen = u32()
    const tag = dec.decode(bytes.slice(off, off + tagLen))
    off += tagLen
    const valLen = u32()
    const val = bytes.slice(off, off + valLen)
    off += valLen
    if (tag === 'body') return dec.decode(val)
  }
  return undefined
}

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
    const msg = await alice.encrypt('peer@local', [pb.deviceId], new TextEncoder().encode('interop hello'))

    // 3. Ship the OmemoMessage as JSON (base64 of the real protobuf `key` bytes + payload).
    writeFileSync(
      SHARED + 'msg.json',
      JSON.stringify({
        sid: msg.sid,
        payload: msg.payload ? b64encode(msg.payload) : null,
        keys: msg.keys.map((k) => ({ rid: k.rid, kex: k.kex, data: b64encode(k.data) })),
      }),
    )

    // 4. The reference decrypts and writes the RAW recovered payload bytes (base64).
    //    A successful, throw-free decrypt already proves every crypto-transport layer
    //    interops (X3DH + Double Ratchet + wire protobuf + payload-key + AES-256-CBC).
    run('decrypt', '/shared/msg.json')
    const recovered = b64decode(readFileSync(SHARED + 'plaintext.b64', 'utf8').trim())

    // 5. Interpret the recovered SCE envelope bytes (Fluux placeholder format) and confirm
    //    the transported body survived byte-for-byte.
    expect(readEnvelopeBody(recovered)).toBe('interop hello')
  })
})
