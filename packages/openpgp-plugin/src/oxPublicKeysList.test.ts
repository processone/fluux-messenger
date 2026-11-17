import { describe, it, expect } from 'vitest'
import type { PEPItem, XMLElementData } from '@fluux/sdk'
import { mergePublicKeysList } from './oxPublicKeysList'

const OX_NS = 'urn:xmpp:openpgp:0'

function meta(fingerprint: string, date: string, attr = 'v4-fingerprint'): XMLElementData {
  return { name: 'pubkey-metadata', attrs: { [attr]: fingerprint, date }, children: [] }
}

function listItem(...children: XMLElementData[]): PEPItem {
  return {
    id: 'current',
    payload: { name: 'public-keys-list', attrs: { xmlns: OX_NS }, children },
  }
}

/** (fingerprint, date) pairs of the merged list, in emitted order. */
function entriesOf(payload: XMLElementData): Array<[string, string]> {
  return payload.children
    .filter((c): c is XMLElementData => typeof c !== 'string')
    .map((c) => [c.attrs['v4-fingerprint'] ?? c.attrs['v6-fingerprint'], c.attrs.date])
}

const OWN = 'FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000'
const SIBLING = 'AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111'
const NOW = '2026-07-22T10:00:00.000Z'

describe('mergePublicKeysList', () => {
  it('keeps a sibling client entry alongside our own', () => {
    const payload = mergePublicKeysList({
      existing: [listItem(meta(SIBLING, '2024-01-02T00:00:00Z'))],
      own: { fingerprint: OWN, date: NOW },
    })

    expect(entriesOf(payload)).toEqual([
      [SIBLING, '2024-01-02T00:00:00Z'],
      [OWN, NOW],
    ])
  })

  it('emits a well-formed <public-keys-list/>', () => {
    const payload = mergePublicKeysList({ existing: [], own: { fingerprint: OWN, date: NOW } })

    expect(payload.name).toBe('public-keys-list')
    expect(payload.attrs.xmlns).toBe(OX_NS)
    expect(entriesOf(payload)).toEqual([[OWN, NOW]])
  })

  it('refreshes our own entry rather than duplicating it', () => {
    const payload = mergePublicKeysList({
      existing: [listItem(meta(OWN, '2020-01-01T00:00:00Z'), meta(SIBLING, '2024-01-02T00:00:00Z'))],
      own: { fingerprint: OWN, date: NOW },
    })

    expect(entriesOf(payload)).toEqual([
      [SIBLING, '2024-01-02T00:00:00Z'],
      [OWN, NOW],
    ])
  })

  it('matches our own entry case-insensitively', () => {
    // Sequoia emits upper-case, openpgp.js lower-case; a case-only difference
    // must not advertise the same key twice.
    const payload = mergePublicKeysList({
      existing: [listItem(meta(OWN.toLowerCase(), '2020-01-01T00:00:00Z'))],
      own: { fingerprint: OWN, date: NOW },
    })

    expect(entriesOf(payload)).toEqual([[OWN, NOW]])
  })

  it('drops fingerprints the caller is retiring', () => {
    // Restoring or replacing our identity must remove the key we no longer
    // hold — otherwise peers keep encrypting to a secret we just discarded.
    const RETIRED = 'BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222'
    const payload = mergePublicKeysList({
      existing: [listItem(meta(RETIRED, '2023-01-01T00:00:00Z'), meta(SIBLING, '2024-01-02T00:00:00Z'))],
      own: { fingerprint: OWN, date: NOW },
      drop: [RETIRED.toLowerCase()],
    })

    expect(entriesOf(payload)).toEqual([
      [SIBLING, '2024-01-02T00:00:00Z'],
      [OWN, NOW],
    ])
  })

  it('preserves a v6 sibling entry under its own attribute', () => {
    const V6 = 'C'.repeat(64)
    const payload = mergePublicKeysList({
      existing: [listItem(meta(V6, '2024-01-02T00:00:00Z', 'v6-fingerprint'))],
      own: { fingerprint: OWN, date: NOW },
    })

    const sibling = payload.children[0] as XMLElementData
    expect(sibling.attrs['v6-fingerprint']).toBe(V6)
    expect(sibling.attrs['v4-fingerprint']).toBeUndefined()
  })

  it('ignores foreign children and entries with no fingerprint', () => {
    const payload = mergePublicKeysList({
      existing: [
        listItem(
          { name: 'pubkey-metadata', attrs: { date: '2024-01-02T00:00:00Z' }, children: [] },
          { name: 'something-else', attrs: { 'v4-fingerprint': SIBLING }, children: [] },
        ),
      ],
      own: { fingerprint: OWN, date: NOW },
    })

    expect(entriesOf(payload)).toEqual([[OWN, NOW]])
  })

  it('ignores items that are not a <public-keys-list/>', () => {
    const payload = mergePublicKeysList({
      existing: [{ id: 'current', payload: { name: 'pubkey', attrs: { xmlns: OX_NS }, children: [] } }],
      own: { fingerprint: OWN, date: NOW },
    })

    expect(entriesOf(payload)).toEqual([[OWN, NOW]])
  })

  it('de-duplicates a fingerprint advertised twice by the server', () => {
    const payload = mergePublicKeysList({
      existing: [listItem(meta(SIBLING, '2024-01-02T00:00:00Z'), meta(SIBLING, '2024-05-05T00:00:00Z'))],
      own: { fingerprint: OWN, date: NOW },
    })

    expect(entriesOf(payload)).toEqual([
      [SIBLING, '2024-01-02T00:00:00Z'],
      [OWN, NOW],
    ])
  })
})
