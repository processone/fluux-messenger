import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import { serializePayloadEnvelope } from '@fluux/sdk'
import { OmemoPlugin } from './OmemoPlugin'
import { createMockPluginContext, type MockNetwork } from './testing/MockPluginContext'
import { parseEncrypted } from './encryptedElement'
import { dataToElement } from './stanzaData'
import { publishDeviceList, fetchDeviceList } from './pep'

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
    await expect(alice.p.encrypt(handle, bodyPayload('leak?'))).rejects.toThrow(/no usable OMEMO devices/i)
  })

  it('encrypt throws when the peer has no devices even though the sender has other own devices', async () => {
    // A peer with zero devices must NOT be masked by encrypt-to-self: give Alice a
    // SECOND own device (so ownDevs is non-empty) and address a peer who published
    // no device list. Without the peerDevs guard, encrypt would return an <encrypted>
    // addressed only to Alice's own devices — undeliverable to bob, reported "secure".
    const alice = await ready('alice@x')
    await ready('alice@x', alice.c.net) // Alice's second own device -> ownDevs non-empty
    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    await expect(alice.p.encrypt(handle, bodyPayload('to nobody but me?'))).rejects.toThrow(
      /no usable OMEMO devices/i,
    )
  })

  it('encrypts to the reachable device and skips a peer device with no published bundle (partial fan-out)', async () => {
    // Bob advertises TWO device ids but only ONE has a bundle. `ensureSessions`
    // establishes a session for the reachable device and skips the other; `encrypt`
    // must then address ONLY the reachable device and succeed. Under the OLD
    // (unfiltered) behavior, `acc.encrypt` would throw `no session for bob@x/<phantom>`
    // on the session-less device, bricking the entire send.
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const bobSid = Number((await bob.p.ensureIdentity()).devices![0]!.deviceId)

    // Add a phantom device id to bob's device-list with NO bundle published for it.
    const PHANTOM = 999999
    const current = await fetchDeviceList(bob.c.ctx.xmpp, 'bob@x')
    await publishDeviceList(bob.c.ctx.xmpp, [...new Set([...current, PHANTOM])])

    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await alice.p.encrypt(handle, bodyPayload('partial hi'))

    // The <encrypted> addresses only the reachable device, never the phantom.
    const msg = parseEncrypted(dataToElement(enc.stanzaElement))
    const bobRids = msg.keys.filter((k) => k.jid === 'bob@x').map((k) => k.rid)
    expect(bobRids).toContain(bobSid)
    expect(bobRids).not.toContain(PHANTOM)

    // And the reachable device really decrypts the body.
    const bHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const res = await bob.p.decrypt(bHandle, bob.p.tryClaimInbound(enc.stanzaElement)!, {})
    expect(res.status ?? 'ok').toBe('ok')
    expect(new TextDecoder().decode(res.plaintext!)).toContain('partial hi')
  })

  it('encrypt throws when the peer has device ids but no bundles (all-unreachable, never silent plaintext)', async () => {
    // A peer whose device-list has ids but NO published bundles yields zero reachable
    // devices after ensureSessions. That must fail LOUD (so the host applies its
    // plaintext policy), never silently emit encrypt-to-self-only ciphertext.
    const alice = await ready('alice@x')
    const bob = createMockPluginContext('bob@x', alice.c.net) // ids published below, but no ensureIdentity => no bundles
    await publishDeviceList(bob.ctx.xmpp, [111, 222])

    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    await expect(alice.p.encrypt(handle, bodyPayload('all unreachable'))).rejects.toThrow(
      /no usable OMEMO devices/i,
    )
  })

  it('persists BTBV trust for a first-seen device decrypted from the archive', async () => {
    // Archive-mode decrypt skips the account's own trust write, so the adapter must
    // persist the resolved BTBV decision itself — otherwise getDeviceTrust reports
    // `unknown` for a device the message surfaced as `tofu`.
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const aliceSid = (await alice.p.ensureIdentity()).devices![0]!.deviceId

    const aHandle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await alice.p.encrypt(aHandle, bodyPayload('archived hi'))

    const bHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const res = await bob.p.decryptArchive(bHandle, bob.p.tryClaimInbound(enc.stanzaElement)!, {})
    expect(res.status ?? 'ok').toBe('ok')
    expect(res.securityContext.trust).toBe('tofu')
    // The surfaced trust was PERSISTED (not left as unknown) for the first-seen device.
    expect(await bob.p.getDeviceTrust('alice@x', aliceSid)).toBe('tofu')
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

describe('OmemoPlugin.encrypt — untrusted exclusion', () => {
  it('excludes an untrusted peer device from recipients while a still-trusted second device is included', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const bobDeviceId = Number((await bob.p.ensureIdentity()).devices![0]!.deviceId)
    // Bob's second device (same bare JID, shared PEP network) so exactly one
    // device can be untrusted while a send still works.
    const bob2 = await ready('bob@x', alice.c.net)
    const secondDeviceId = Number((await bob2.p.ensureIdentity()).devices![0]!.deviceId)

    await alice.p.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')

    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await alice.p.encrypt(handle, bodyPayload('hi'))
    const msg = parseEncrypted(dataToElement(enc.stanzaElement))
    const recipientDeviceIds = msg.keys.filter((k) => k.jid === 'bob@x').map((k) => k.rid)
    expect(recipientDeviceIds).not.toContain(bobDeviceId)
    expect(recipientDeviceIds).toContain(secondDeviceId)
  })

  it('throws the loud no-usable-devices error when EVERY peer device is untrusted', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const bobDeviceId = Number((await bob.p.ensureIdentity()).devices![0]!.deviceId)
    await alice.p.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')

    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    await expect(alice.p.encrypt(handle, bodyPayload('leak?'))).rejects.toThrow(/no usable OMEMO devices/i)
  })

  it('pre-verification blind trust: nothing excluded (current behavior preserved)', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const bobDeviceId = Number((await bob.p.ensureIdentity()).devices![0]!.deviceId)

    const handle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const enc = await alice.p.encrypt(handle, bodyPayload('hello'))
    const msg = parseEncrypted(dataToElement(enc.stanzaElement))
    expect(msg.keys.map((k) => k.rid)).toContain(bobDeviceId)
  })
})
