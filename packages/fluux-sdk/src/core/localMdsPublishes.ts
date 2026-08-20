const LOCAL_PUBLISH_TTL_MS = 60_000

const publishes = new Map<string, Map<string, Map<string, number>>>()

export function markLocallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
  stanzaId: string,
): void {
  if (!accountJid) return
  let conversations = publishes.get(accountJid)
  if (!conversations) {
    conversations = new Map()
    publishes.set(accountJid, conversations)
  }
  let markers = conversations.get(conversationJid)
  if (!markers) {
    markers = new Map()
    conversations.set(conversationJid, markers)
  }
  markers.set(stanzaId, Date.now() + LOCAL_PUBLISH_TTL_MS)
}

export function forgetLocallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
  stanzaId: string,
): void {
  const conversations = publishes.get(accountJid)
  const markers = conversations?.get(conversationJid)
  if (!markers) return
  markers.delete(stanzaId)
  if (markers.size === 0) conversations?.delete(conversationJid)
  if (conversations?.size === 0) publishes.delete(accountJid)
}

export function wasLocallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
  stanzaId: string,
): boolean {
  const expiresAt = publishes.get(accountJid)?.get(conversationJid)?.get(stanzaId)
  if (expiresAt === undefined) return false
  if (expiresAt >= Date.now()) return true
  forgetLocallyPublishedDisplayed(accountJid, conversationJid, stanzaId)
  return false
}

export function clearLocallyPublishedDisplayed(accountJid: string): void {
  publishes.delete(accountJid)
}
