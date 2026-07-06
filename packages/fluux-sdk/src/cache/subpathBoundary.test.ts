import { describe, it, expect } from 'vitest'
import * as mainEntry from '../index'
import * as cacheEntry from './index'

/**
 * The low-level IndexedDB message/avatar cache is an advanced escape hatch
 * whose write/delete ops bypass store invariants — it must not sit on the
 * curated main entry. This guard pins it to the `@fluux/sdk/cache` subpath.
 */
describe('cache subpath boundary', () => {
  const cacheSymbols = [
    'saveMessage', 'saveMessages', 'getMessage', 'getMessageByStanzaId',
    'getMessages', 'getMessageCount', 'updateMessage', 'deleteMessage',
    'deleteConversationMessages', 'getOldestMessageTimestamp',
    'saveRoomMessage', 'saveRoomMessages', 'getRoomMessage',
    'getRoomMessageByStanzaId', 'getRoomMessages', 'getRoomMessageCount',
    'updateRoomMessage', 'deleteRoomMessage', 'deleteRoomMessages',
    'getOldestRoomMessageTimestamp', 'clearAllMessages', 'isMessageCacheAvailable',
    'clearAllAvatarData', 'revokeAllBlobUrls', 'getBlobUrlPoolSize',
    'bumpAvatarResumeCount', 'getAvatarResumeCount',
  ]

  it('does not export cache accessors from the main entry', () => {
    const leaked = Object.keys(mainEntry).filter((k) => cacheSymbols.includes(k))
    expect(leaked).toEqual([])
  })

  it('exports every cache accessor from the /cache subpath', () => {
    const present = new Set(Object.keys(cacheEntry))
    const missing = cacheSymbols.filter((s) => !present.has(s))
    expect(missing).toEqual([])
  })
})
