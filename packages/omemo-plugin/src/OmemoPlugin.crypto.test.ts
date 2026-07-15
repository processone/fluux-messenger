import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import { serializePayloadEnvelope } from '@fluux/sdk'
import { OmemoPlugin } from './OmemoPlugin'
import { createMockPluginContext, type MockNetwork } from './testing/MockPluginContext'

/** Spin up a plugin bound to a fresh (or shared) mock PEP network, identity published. */
async function ready(jid: string, net?: MockNetwork) {
  const c = createMockPluginContext(jid, net)
  const p = new OmemoPlugin()
  await p.init(c.ctx)
  await p.ensureIdentity()
  return { p, c }
}

/** Serialize a host `<payload>` fragment carrying a single body element. */
function bodyPayload(text: string): Uint8Array {
  return new TextEncoder().encode(
    serializePayloadEnvelope([xml('body', { xmlns: 'jabber:client' }, text)]),
  )
}

describe('OmemoPlugin encrypt/decrypt (SCE seam)', () => {
  it('Alice encrypts a body and Bob decrypts it back through real SCE', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)

    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await alice.p.encrypt(handle, bodyPayload('hi bob'))
    expect(enc.stanzaElement.name).toBe('encrypted')

    const claimed = bob.p.tryClaimInbound(enc.stanzaElement)
    expect(claimed).not.toBeNull()

    const bobHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const res = await bob.p.decrypt(bobHandle, claimed!, { messageId: 'm1' })
    expect(res.status ?? 'ok').toBe('ok')
    expect(new TextDecoder().decode(res.plaintext!)).toContain('hi bob')
    // Blind-trust-before-verification: a first-seen device surfaces as tofu.
    expect(res.securityContext.trust).toBe('tofu')
    // The SCE <time> affix round-trips to a sender-attested authoredAt.
    expect(res.authoredAt).toBeInstanceOf(Date)
  })

  it('an established session carries follow-up messages both directions', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const aHandle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const bHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })

    // 1) Alice -> Bob (key-exchange first contact)
    const m1 = await alice.p.encrypt(aHandle, bodyPayload('one'))
    const r1 = await bob.p.decrypt(bHandle, bob.p.tryClaimInbound(m1.stanzaElement)!, {})
    expect(new TextDecoder().decode(r1.plaintext!)).toContain('one')

    // 2) Bob -> Alice (reply on the freshly established session)
    const m2 = await bob.p.encrypt(bHandle, bodyPayload('two'))
    const r2 = await alice.p.decrypt(aHandle, alice.p.tryClaimInbound(m2.stanzaElement)!, {})
    expect(new TextDecoder().decode(r2.plaintext!)).toContain('two')

    // 3) Alice -> Bob again (established; must NOT re-handshake / clobber the ratchet)
    const m3 = await alice.p.encrypt(aHandle, bodyPayload('three'))
    const r3 = await bob.p.decrypt(bHandle, bob.p.tryClaimInbound(m3.stanzaElement)!, {})
    expect(new TextDecoder().decode(r3.plaintext!)).toContain('three')
  })

  it('a tampered <payload> byte yields broken-session (never a throw, never plaintext)', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await alice.p.encrypt(handle, bodyPayload('secret'))

    // Flip a byte inside the base64 <payload> ciphertext (keep it valid base64).
    const stanza = structuredClone(enc.stanzaElement)
    const payloadEl = stanza.children.find(
      (c): c is typeof stanza => typeof c !== 'string' && c.name === 'payload',
    )!
    const b64 = payloadEl.children[0] as string
    const flip = (ch: string) => (ch === 'A' ? 'B' : 'A')
    payloadEl.children[0] = flip(b64[0]) + b64.slice(1)

    const bobHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const res = await bob.p.decrypt(bobHandle, { protocolId: enc.protocolId, stanzaElement: stanza }, {})
    expect(res.status).toBe('broken-session')
    expect(res.plaintext).toBeUndefined()
  })

  it('a message with no <key> for our device yields broken-session (no throw to host)', async () => {
    const alice = await ready('alice@x')
    await ready('bob@x', alice.c.net) // publishes bob's devices so alice can address them
    const carol = await ready('carol@x', alice.c.net) // never addressed

    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await alice.p.encrypt(handle, bodyPayload('for bob only'))

    const carolHandle = await carol.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const res = await carol.p.decrypt(carolHandle, carol.p.tryClaimInbound(enc.stanzaElement)!, {})
    expect(res.status).toBe('broken-session')
    expect(res.plaintext).toBeUndefined()
  })

  it('encrypt with no peer devices throws rather than sending plaintext', async () => {
    const alice = await ready('alice@x')
    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'nobody@x' })
    await expect(alice.p.encrypt(handle, bodyPayload('leak?'))).rejects.toThrow(/no recipient devices/i)
  })

  it('a 0-length key-transport decrypts as control-message with no plaintext', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)

    // Capture the empty key-transport stanza repairSession emits.
    let sent: import('@fluux/sdk').XMLElementData | undefined
    alice.c.ctx.xmpp.sendStanza = async (s) => {
      sent = s
    }
    const aHandle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    await alice.p.repairSession(aHandle, 'bob@x')
    expect(sent).toBeDefined()

    const encryptedChild = sent!.children.find(
      (c): c is import('@fluux/sdk').XMLElementData => typeof c !== 'string' && c.name === 'encrypted',
    )!
    const bHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const res = await bob.p.decrypt(bHandle, bob.p.tryClaimInbound(encryptedChild)!, {})
    expect(res.status).toBe('control-message')
    expect(res.plaintext).toBeUndefined()
  })

  it('getPeerTrust surfaces tofu once a device has been seen via decrypt', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await alice.p.encrypt(handle, bodyPayload('hello'))
    const bHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    await bob.p.decrypt(bHandle, bob.p.tryClaimInbound(enc.stanzaElement)!, {})
    expect(await bob.p.getPeerTrust('alice@x')).toBe('tofu')
  })
})
