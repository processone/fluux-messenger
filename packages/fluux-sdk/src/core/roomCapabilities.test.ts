import { describe, it, expect } from 'vitest'
import { hasStableOccupantIdentity } from './roomCapabilities'

describe('hasStableOccupantIdentity', () => {
  const NS_OCCUPANT_ID = 'urn:xmpp:occupant-id:0'

  // Base features present in most MUC rooms
  const baseMucFeatures = [
    'http://jabber.org/protocol/muc',
    'muc_persistent',
  ]

  it('returns true for non-anonymous rooms (JIDs visible to all)', () => {
    const features = [...baseMucFeatures, 'muc_nonanonymous', 'muc_open']
    expect(hasStableOccupantIdentity(features)).toBe(true)
  })

  it('returns true for members-only semi-anonymous rooms', () => {
    const features = [...baseMucFeatures, 'muc_semianonymous', 'muc_membersonly']
    expect(hasStableOccupantIdentity(features)).toBe(true)
  })

  it('returns true for open semi-anonymous rooms with occupant-id support', () => {
    const features = [...baseMucFeatures, 'muc_semianonymous', 'muc_open', NS_OCCUPANT_ID]
    expect(hasStableOccupantIdentity(features)).toBe(true)
  })

  it('returns false for open semi-anonymous rooms without occupant-id', () => {
    const features = [...baseMucFeatures, 'muc_semianonymous', 'muc_open']
    expect(hasStableOccupantIdentity(features)).toBe(false)
  })

  it('returns true for non-anonymous members-only rooms', () => {
    const features = [...baseMucFeatures, 'muc_nonanonymous', 'muc_membersonly']
    expect(hasStableOccupantIdentity(features)).toBe(true)
  })

  it('returns true when occupant-id alone is present (regardless of other flags)', () => {
    const features = [...baseMucFeatures, NS_OCCUPANT_ID]
    expect(hasStableOccupantIdentity(features)).toBe(true)
  })

  it('returns true when no anonymity or access flags are advertised (optimistic default)', () => {
    const features = [...baseMucFeatures]
    expect(hasStableOccupantIdentity(features)).toBe(true)
  })

  it('returns true for empty features array (optimistic default)', () => {
    expect(hasStableOccupantIdentity([])).toBe(true)
  })

  it('prioritizes non-anonymous over semi-anonymous when both present', () => {
    // Unusual but possible: both anonymity flags present
    const features = [...baseMucFeatures, 'muc_nonanonymous', 'muc_semianonymous', 'muc_open']
    expect(hasStableOccupantIdentity(features)).toBe(true)
  })

  it('prioritizes members-only over open when both present', () => {
    // Unusual but possible: both access flags present
    const features = [...baseMucFeatures, 'muc_semianonymous', 'muc_membersonly', 'muc_open']
    expect(hasStableOccupantIdentity(features)).toBe(true)
  })
})
