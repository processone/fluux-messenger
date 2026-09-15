import type { SearchResult } from '@fluux/sdk'

export function searchResultMessageIdentity(result: SearchResult) {
  return {
    type: result.isRoom ? 'groupchat' as const : 'chat' as const,
    id: result.messageId, from: result.from, occupantId: result.occupantId,
    stanzaId: result.stanzaId, originId: result.originId,
    ...(result.isRoom ? { roomJid: result.conversationId } : {}),
  }
}
