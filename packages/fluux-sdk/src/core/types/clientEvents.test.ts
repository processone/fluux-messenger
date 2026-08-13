/**
 * Guards the boundary between the client's public event surface and the signals
 * it raises for itself.
 *
 * These are compile-time assertions: `npm run typecheck` fails if the boundary
 * moves, which is the only way a type-level contract can be enforced. The
 * runtime expectations exist so the file is a test rather than a stray module.
 */
import { describe, it, expect } from 'vitest'
import type { ClientEvents, InternalClientEvents, XMPPClientEvents } from './index'

type PublicEventName = keyof XMPPClientEvents
type InternalEventName = keyof InternalClientEvents

describe('the client event surface', () => {
  it('keeps internal signals out of the public surface', () => {
    // Each `@ts-expect-error` fails the build if the name becomes publicly
    // assignable, which is what would happen if someone moved one back.
    // @ts-expect-error `mucJoined` is internal plumbing, not a consumer contract
    const a: PublicEventName = 'mucJoined'
    // @ts-expect-error `rosterLoaded` is internal plumbing
    const b: PublicEventName = 'rosterLoaded'
    // @ts-expect-error `avatarMetadataUpdate` is internal plumbing
    const c: PublicEventName = 'avatarMetadataUpdate'
    // @ts-expect-error `roomAvatarUpdate` is internal plumbing
    const d: PublicEventName = 'roomAvatarUpdate'
    // @ts-expect-error `occupantAvatarUpdate` is internal plumbing
    const e: PublicEventName = 'occupantAvatarUpdate'
    // @ts-expect-error `contactMissingXep0153Avatar` is internal plumbing
    const f: PublicEventName = 'contactMissingXep0153Avatar'
    expect([a, b, c, d, e, f]).toHaveLength(6)
  })

  // Removing one of these breaks every bot built on `@fluux/sdk/core`, so the
  // build should say so rather than a consumer's runtime.
  it('keeps the documented bot-facing events public', () => {
    const documented: PublicEventName[] = [
      'stanza', 'message', 'presence', 'roster',
      'online', 'offline', 'resumed', 'reconnecting', 'error',
    ]
    expect(documented).toHaveLength(9)
  })

  it('carries both halves on the bus modules emit against', () => {
    const fromPublic: keyof ClientEvents = 'message' satisfies PublicEventName
    const fromInternal: keyof ClientEvents = 'mucJoined' satisfies InternalEventName
    expect([fromPublic, fromInternal]).toEqual(['message', 'mucJoined'])
  })

  it('overlaps in no name, so the intersection loses nothing', () => {
    // A name in both would silently take the intersection of its two handler
    // types, which is neither signature.
    type Overlap = PublicEventName & InternalEventName
    const overlap: Overlap[] = []
    expect(overlap).toEqual([])
  })
})
