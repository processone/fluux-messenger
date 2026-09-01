/**
 * The one definition of a room message's identity (XEP-0359), shared by the
 * resident-window dedup (`roomStore.getRoomMessageKeys`) and the message cache.
 * One logical message appears as several stanzas (optimistic echo, MUC reflection,
 * MAM copy) with no single stable field. They are matched through a tiered
 * identity, most-specific first: stanzaId, then originId, then from+id. Two copies
 * are the same logical message iff they share ANY of these keys.
 */
export interface RoomIdentityFields {
  roomJid: string
  from: string
  id: string
  stanzaId?: string
  originId?: string
}

export type RoomIdentityTier = 'stanzaId' | 'originId' | 'fallback'

export interface RoomReferenceProbe<T> {
  tier: RoomIdentityTier
  authoritative: boolean
  matches: (message: T) => boolean
}

export interface RoomReferenceResolution<T> {
  tier: RoomIdentityTier
  authoritative: boolean
  candidates: Array<{ message: T; index: number }>
}

// U+0000 separator: JIDs/ids/stanzaIds cannot contain it, so joins never collide.
const S = '\u0000'

/**
 * Room-scope a tier key. stanzaId/originId are assigned per-archive and can repeat
 * across rooms; the identityKeys index spans the whole store, so an unscoped key
 * would let the finder merge messages from different rooms.
 */
function scoped(roomJid: string, tier: string): string {
  return `room${S}${roomJid}${S}${tier}`
}

/** Every identity key the message carries, most-specific first. For matching. */
export function roomIdentityKeys(m: RoomIdentityFields): string[] {
  const keys: string[] = []
  if (m.stanzaId) keys.push(scoped(m.roomJid, `stanzaId${S}${m.stanzaId}`))
  if (m.originId) keys.push(scoped(m.roomJid, `originId${S}${m.originId}`))
  keys.push(scoped(m.roomJid, `from${S}${m.from}${S}id${S}${m.id}`))
  return keys
}

/** The single canonical key — the highest tier present. For the primary key. */
export function roomCanonicalKey(m: RoomIdentityFields): string {
  return roomIdentityKeys(m)[0]
}

/**
 * The room-scoped stanzaId identity key — the single tier a stanzaId contributes.
 * Used by getRoomMessageByStanzaId (room-scoped lookup) and by updateRoomMessage
 * revocation (removing the cleared alias). Matches the key roomIdentityKeys emits
 * for the same stanzaId, so the two always agree.
 */
export function roomStanzaKey(roomJid: string, stanzaId: string): string {
  return scoped(roomJid, `stanzaId${S}${stanzaId}`)
}

/** The room-scoped originId identity key (for revocation). Mirrors {@link roomStanzaKey}. */
export function roomOriginKey(roomJid: string, originId: string): string {
  return scoped(roomJid, `originId${S}${originId}`)
}

export function roomReferenceProbes<T extends Pick<RoomIdentityFields, 'id' | 'stanzaId' | 'originId'>>(
  reference: string
): RoomReferenceProbe<T>[] {
  return [
    { tier: 'stanzaId', authoritative: true, matches: (message) => message.stanzaId === reference },
    { tier: 'originId', authoritative: true, matches: (message) => message.originId === reference },
    { tier: 'fallback', authoritative: false, matches: (message) => message.id === reference },
  ]
}

export function resolveRoomMessageReference<T extends Pick<RoomIdentityFields, 'id' | 'stanzaId' | 'originId'>>(
  messages: readonly T[],
  reference: string
): RoomReferenceResolution<T> | undefined {
  for (const probe of roomReferenceProbes<T>(reference)) {
    const candidates: RoomReferenceResolution<T>['candidates'] = []
    messages.forEach((message, index) => {
      if (probe.matches(message)) candidates.push({ message, index })
    })
    if (candidates.length > 0) {
      return { tier: probe.tier, authoritative: probe.authoritative, candidates }
    }
  }
  return undefined
}
