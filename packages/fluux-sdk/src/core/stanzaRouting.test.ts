/**
 * Stanza routing: the matcher, the ordering, and the structural guard that no
 * two modules claim the same shape without saying who goes first.
 */
import { describe, it, expect, vi } from 'vitest'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import {
  claimMatches,
  claimSpecificity,
  findAmbiguousClaims,
  routeStanza,
  selectClaimants,
  type StanzaClaim,
  type StanzaClaimant,
} from './stanzaRouting'
import { NS_PUBSUB, NS_MUC_USER } from './namespaces'
import { PUBSUB_CLAIMS } from './modules/PubSub'
import { BLOCKING_CLAIMS } from './modules/Blocking'
import { POLL_CLAIMS } from './modules/Poll'
import { CHAT_CLAIMS } from './modules/Chat'
import { MUC_CLAIMS } from './modules/MUC'
import { ROSTER_CLAIMS } from './modules/Roster'

const NS_PUBSUB_EVENT = `${NS_PUBSUB}#event`

function claimant(claims: StanzaClaim[], consumes = true): StanzaClaimant & { seen: Element[] } {
  const seen: Element[] = []
  return { claims, seen, handle: (stanza) => { seen.push(stanza); return consumes } }
}

describe('claimMatches', () => {
  it('matches on stanza kind', () => {
    expect(claimMatches({ kind: 'message' }, xml('message'))).toBe(true)
    expect(claimMatches({ kind: 'message' }, xml('presence'))).toBe(false)
  })

  it('requires the named child, namespace included', () => {
    const claim: StanzaClaim = { kind: 'message', child: { name: 'event', ns: NS_PUBSUB_EVENT } }
    expect(claimMatches(claim, xml('message', {}, xml('event', { xmlns: NS_PUBSUB_EVENT })))).toBe(true)
    expect(claimMatches(claim, xml('message', {}, xml('event', { xmlns: 'urn:other' })))).toBe(false)
    expect(claimMatches(claim, xml('message'))).toBe(false)
  })

  it('matches an exact type', () => {
    const claim: StanzaClaim = { kind: 'presence', type: 'error' }
    expect(claimMatches(claim, xml('presence', { type: 'error' }))).toBe(true)
    expect(claimMatches(claim, xml('presence', { type: 'unavailable' }))).toBe(false)
    expect(claimMatches(claim, xml('presence'))).toBe(false)
  })

  it('uses null to mean "no type attribute", which is available presence', () => {
    const claim: StanzaClaim = { kind: 'presence', type: null }
    expect(claimMatches(claim, xml('presence'))).toBe(true)
    expect(claimMatches(claim, xml('presence', { from: 'a@b/c' }))).toBe(true)
    expect(claimMatches(claim, xml('presence', { type: 'unavailable' }))).toBe(false)
  })

  it('matches any namespace when the child claim omits one', () => {
    const claim: StanzaClaim = { kind: 'message', child: { name: 'body' } }
    expect(claimMatches(claim, xml('message', {}, xml('body', { xmlns: 'urn:whatever' })))).toBe(true)
    expect(claimMatches(claim, xml('message', {}, xml('subject')))).toBe(false)
  })

  it('treats an empty type attribute as no type', () => {
    expect(claimMatches({ kind: 'presence', type: null }, xml('presence', { type: '' }))).toBe(true)
  })

  it('leaves type unconstrained when the claim omits it', () => {
    const claim: StanzaClaim = { kind: 'presence' }
    expect(claimMatches(claim, xml('presence'))).toBe(true)
    expect(claimMatches(claim, xml('presence', { type: 'error' }))).toBe(true)
  })
})

describe('claimSpecificity', () => {
  it('ranks child over type over bare kind', () => {
    expect(claimSpecificity({ kind: 'presence' })).toBe(0)
    expect(claimSpecificity({ kind: 'presence', type: 'error' })).toBe(1)
    expect(claimSpecificity({ kind: 'presence', child: { name: 'x' } })).toBe(2)
    expect(claimSpecificity({ kind: 'presence', type: 'error', child: { name: 'x' } })).toBe(3)
  })
})

describe('selectClaimants', () => {
  it('offers the most specific claim first', () => {
    const broad = claimant([{ kind: 'message' }])
    const narrow = claimant([{ kind: 'message', child: { name: 'event', ns: NS_PUBSUB_EVENT } }])
    const stanza = xml('message', {}, xml('event', { xmlns: NS_PUBSUB_EVENT }))
    expect(selectClaimants(stanza, [broad, narrow])).toEqual([narrow, broad])
  })

  it('is independent of the order the claimants are listed in', () => {
    const broad = claimant([{ kind: 'message' }])
    const narrow = claimant([{ kind: 'message', child: { name: 'event', ns: NS_PUBSUB_EVENT } }])
    const stanza = xml('message', {}, xml('event', { xmlns: NS_PUBSUB_EVENT }))
    expect(selectClaimants(stanza, [narrow, broad])).toEqual([narrow, broad])
    expect(selectClaimants(stanza, [broad, narrow])).toEqual([narrow, broad])
  })

  it('omits claimants whose claims do not match', () => {
    const presence = claimant([{ kind: 'presence' }])
    const message = claimant([{ kind: 'message' }])
    expect(selectClaimants(xml('presence'), [presence, message])).toEqual([presence])
  })

  it('ranks a multi-claim module by its strongest matching claim', () => {
    const multi = claimant([{ kind: 'presence' }, { kind: 'presence', type: 'error' }])
    const single = claimant([{ kind: 'presence', type: 'error' }])
    // Equal specificity, so declaration order breaks the tie — but only there.
    expect(selectClaimants(xml('presence', { type: 'error' }), [single, multi])).toEqual([single, multi])
  })

  it('breaks an equal-specificity tie with the declared priority', () => {
    const low = claimant([{ kind: 'iq', type: 'set' }])
    const high = claimant([{ kind: 'iq', type: 'set', priority: 10 }])
    expect(selectClaimants(xml('iq', { type: 'set' }), [low, high])).toEqual([high, low])
  })
})

describe('routeStanza', () => {
  it('stops at the first claimant that consumes', () => {
    const first = claimant([{ kind: 'message', child: { name: 'event', ns: NS_PUBSUB_EVENT } }])
    const second = claimant([{ kind: 'message' }])
    routeStanza(xml('message', {}, xml('event', { xmlns: NS_PUBSUB_EVENT })), [first, second])
    expect(first.seen).toHaveLength(1)
    expect(second.seen).toHaveLength(0)
  })

  it('continues past a claimant that declines', () => {
    const declines = claimant([{ kind: 'presence', type: 'error' }], false)
    const fallback = claimant([{ kind: 'presence' }])
    routeStanza(xml('presence', { type: 'error' }), [declines, fallback])
    expect(declines.seen).toHaveLength(1)
    expect(fallback.seen).toHaveLength(1)
  })

  it('runs matching observers even when a claimant consumed the stanza', () => {
    const consumer = claimant([{ kind: 'presence' }])
    const observe = vi.fn()
    routeStanza(xml('presence'), [consumer], [{ observes: [{ kind: 'presence', type: null }], observe }])
    expect(consumer.seen).toHaveLength(1)
    expect(observe).toHaveBeenCalledTimes(1)
  })

  it('isolates a throwing observer from the others and from the caller', () => {
    const later = vi.fn()
    expect(() => routeStanza(xml('presence'), [], [
      { observes: [{ kind: 'presence' }], observe: () => { throw new Error('boom') } },
      { observes: [{ kind: 'presence' }], observe: later },
    ])).not.toThrow()
    expect(later).toHaveBeenCalledTimes(1)
  })

  // Deliberately asymmetric: a claimant that fails while CONSUMING a stanza is
  // a real error, and swallowing it would hide a broken feature.
  it('lets a throwing claimant propagate', () => {
    expect(() => routeStanza(xml('message'), [
      { claims: [{ kind: 'message' }], handle: () => { throw new Error('boom') } },
    ])).toThrow('boom')
  })

  it('runs every matching observer', () => {
    const a = vi.fn()
    const b = vi.fn()
    routeStanza(xml('presence'), [], [
      { observes: [{ kind: 'presence' }], observe: a },
      { observes: [{ kind: 'presence' }], observe: b },
    ])
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when nothing claims or observes the stanza', () => {
    const other = claimant([{ kind: 'iq' }])
    expect(() => routeStanza(xml('presence'), [other], [])).not.toThrow()
    expect(other.seen).toHaveLength(0)
  })

  it('never offers a stanza to a claimant that declares no claims', () => {
    const silent = claimant([])
    routeStanza(xml('message'), [silent])
    expect(silent.seen).toHaveLength(0)
  })

  it('ignores stanza kinds nothing can claim', () => {
    const all = claimant([{ kind: 'message' }, { kind: 'presence' }, { kind: 'iq' }])
    routeStanza(xml('features'), [all])
    expect(all.seen).toHaveLength(0)
  })

  it('does not run an observer whose claim does not match', () => {
    const observe = vi.fn()
    routeStanza(xml('presence', { type: 'unavailable' }), [], [
      { observes: [{ kind: 'presence', type: null }], observe },
    ])
    expect(observe).not.toHaveBeenCalled()
  })
})

describe('findAmbiguousClaims', () => {
  it('reports two modules naming the same shape at the same priority', () => {
    const found = findAmbiguousClaims([
      { name: 'A', claims: [{ kind: 'iq', type: 'set' }] },
      { name: 'B', claims: [{ kind: 'iq', type: 'set' }] },
    ])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ a: 'A', b: 'B' })
  })

  it('accepts the same shape once a priority separates them', () => {
    expect(findAmbiguousClaims([
      { name: 'A', claims: [{ kind: 'iq', type: 'set' }] },
      { name: 'B', claims: [{ kind: 'iq', type: 'set', priority: 1 }] },
    ])).toEqual([])
  })

  it('reports every conflicting pair across more than two modules', () => {
    const found = findAmbiguousClaims([
      { name: 'A', claims: [{ kind: 'iq', type: 'set' }] },
      { name: 'B', claims: [{ kind: 'iq', type: 'set' }] },
      { name: 'C', claims: [{ kind: 'iq', type: 'set' }] },
    ])
    expect(found.map((f) => `${f.a}/${f.b}`)).toEqual(['A/B', 'A/C', 'B/C'])
  })

  it('separates claims that differ only by child namespace', () => {
    expect(findAmbiguousClaims([
      { name: 'A', claims: [{ kind: 'iq', child: { name: 'query', ns: 'urn:a' } }] },
      { name: 'B', claims: [{ kind: 'iq', child: { name: 'query', ns: 'urn:b' } }] },
    ])).toEqual([])
  })

  it('does not report claims of different specificity, which is the mechanism working', () => {
    expect(findAmbiguousClaims([
      { name: 'Chat', claims: [{ kind: 'message' }] },
      { name: 'PubSub', claims: [{ kind: 'message', child: { name: 'event', ns: NS_PUBSUB_EVENT } }] },
    ])).toEqual([])
  })
})

/**
 * The guard the hand-ordered array could not provide: the real modules' claims,
 * checked for an overlap that only declaration order would settle.
 */
describe('the routed modules', () => {
  // The modules' own claim constants, not a copy: a module that changes what
  // it claims changes this guard with it.
  const REAL_CLAIMS = [
    { name: 'PubSub', claims: PUBSUB_CLAIMS },
    { name: 'Blocking', claims: BLOCKING_CLAIMS },
    { name: 'Poll', claims: POLL_CLAIMS },
    { name: 'Chat', claims: CHAT_CLAIMS },
    { name: 'MUC', claims: MUC_CLAIMS },
    { name: 'Roster', claims: ROSTER_CLAIMS },
  ]

  it('leave no overlap that only declaration order would settle', () => {
    expect(findAmbiguousClaims(REAL_CLAIMS)).toEqual([])
  })

  it('order MUC ahead of Roster for room presence and for error presence', () => {
    const order = (stanza: Element) =>
      selectClaimants(stanza, REAL_CLAIMS.map((m) => ({ ...m, handle: () => false })))
        .map((m) => (m as { name: string }).name)

    expect(order(xml('presence', {}, xml('x', { xmlns: NS_MUC_USER })))).toEqual(['MUC', 'Roster'])
    expect(order(xml('presence', { type: 'error' }))).toEqual(['MUC', 'Roster'])
    // Ordinary contact presence is Roster's alone.
    expect(order(xml('presence', { from: 'a@b/c' }))).toEqual(['Roster'])
  })

  it('order PubSub ahead of Chat for event payloads only', () => {
    const order = (stanza: Element) =>
      selectClaimants(stanza, REAL_CLAIMS.map((m) => ({ ...m, handle: () => false })))
        .map((m) => (m as { name: string }).name)

    expect(order(xml('message', {}, xml('event', { xmlns: NS_PUBSUB_EVENT })))).toEqual(['PubSub', 'Chat'])
    expect(order(xml('message', {}, xml('body', {}, 'hi')))).toEqual(['Chat'])
  })
})
