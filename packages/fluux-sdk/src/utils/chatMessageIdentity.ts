/**
 * The one definition of a 1:1 chat message's identity (XEP-0359), shared by the
 * resident-window dedup (`chatStore`'s timeline config) and the durable
 * retraction boundary. The 1:1 twin of {@link module:Utils/RoomMessageIdentity}:
 * the same tiered ladder — stanzaId, then originId, then from+id — with two
 * copies being the same logical message iff they share ANY key.
 *
 * Unlike the room ladder these keys are NOT scoped by conversation. A 1:1
 * message traverses one archive (the account's own), and `from` already pins the
 * lowest tier to a sender, so the keys are usable across conversations.
 *
 * @module Utils/ChatMessageIdentity
 */

/** The fields the chat ladder reads. `Message` satisfies it. */
export interface ChatIdentityFields {
  from: string
  id: string
  stanzaId?: string
  originId?: string
}

export type ChatIdentityTier = 'stanzaId' | 'originId' | 'fallback'

export interface ChatReferenceProbe<T> {
  tier: ChatIdentityTier
  authoritative: boolean
  matches: (message: T) => boolean
}

export interface ChatReferenceResolution<T> {
  tier: ChatIdentityTier
  authoritative: boolean
  candidates: Array<{ message: T; index: number }>
}

export interface ChatIdentityProbe<T> extends ChatReferenceProbe<T> {
  reference: string
}

/** Every identity key the message carries, most-specific first. For matching. */
export function chatIdentityKeys(m: ChatIdentityFields): string[] {
  const keys: string[] = []
  if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
  if (m.originId) keys.push(`originId:${m.originId}`)
  keys.push(`from:${m.from}:id:${m.id}`)
  return keys
}

/** The single canonical key — the highest tier present. */
export function chatCanonicalKey(m: ChatIdentityFields): string {
  return chatIdentityKeys(m)[0]
}

export function chatReferenceProbes<T extends Pick<ChatIdentityFields, 'id' | 'stanzaId' | 'originId'>>(
  reference: string
): ChatReferenceProbe<T>[] {
  return [
    { tier: 'stanzaId', authoritative: true, matches: (message) => message.stanzaId === reference },
    { tier: 'originId', authoritative: true, matches: (message) => message.originId === reference },
    { tier: 'fallback', authoritative: false, matches: (message) => message.id === reference },
  ]
}

export function chatIdentityProbes<T extends Pick<ChatIdentityFields, 'id' | 'stanzaId' | 'originId'>>(
  message: Pick<ChatIdentityFields, 'id' | 'stanzaId' | 'originId'>
): ChatIdentityProbe<T>[] {
  const references: Record<ChatIdentityTier, string | undefined> = {
    stanzaId: message.stanzaId,
    originId: message.originId,
    fallback: message.id,
  }
  return chatReferenceProbes<T>('').flatMap((tierProbe) => {
    const reference = references[tierProbe.tier]
    if (!reference) return []
    const probe = chatReferenceProbes<T>(reference).find(({ tier }) => tier === tierProbe.tier)!
    return [{ ...probe, reference }]
  })
}

export function resolveChatMessageReference<T extends Pick<ChatIdentityFields, 'id' | 'stanzaId' | 'originId'>>(
  messages: readonly T[],
  reference: string
): ChatReferenceResolution<T> | undefined {
  for (const probe of chatReferenceProbes<T>(reference)) {
    const candidates: ChatReferenceResolution<T>['candidates'] = []
    messages.forEach((message, index) => {
      if (probe.matches(message)) candidates.push({ message, index })
    })
    if (candidates.length > 0) {
      return { tier: probe.tier, authoritative: probe.authoritative, candidates }
    }
  }
  return undefined
}
