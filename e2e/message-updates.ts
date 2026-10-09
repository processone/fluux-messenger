import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { chatStore, roomStore } from '@fluux/sdk'
import { loadDemo, activateChat, navigateToStressRoom, STRESS_ROOM_JID } from './harness/scrollHarness'

type DemoWindow = Window & {
  __demoClient: DemoClient
  __chatStore: typeof chatStore
  __roomStore: typeof roomStore
}

async function cachedPreview(page: Page, kind: 'chat' | 'room', id: string): Promise<string | null> {
  return page.evaluate(async ({ kind, id }) => {
    const databases = await indexedDB.databases()
    const name = databases.find(db => db.name?.startsWith('fluux-message-cache'))?.name
    if (!name) return null
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const rows = await new Promise<Array<{ id: string; linkPreview?: { title?: string } }>>((resolve, reject) => {
        const request = db.transaction(kind === 'chat' ? 'messages-canonical' : 'room-messages-canonical')
          .objectStore(kind === 'chat' ? 'messages-canonical' : 'room-messages-canonical').getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      return rows.find(row => row.id === id)?.linkPreview?.title ?? null
    } finally { db.close() }
  }, { kind, id })
}

for (const kind of ['chat', 'room'] as const) {
  for (const delay of ['inactive', 0, 16, 50] as const) {
    test(`${kind} preview survives ${delay} fastening and cache reload`, async ({ page }) => {
      await loadDemo(page)
      const jid = kind === 'chat' ? 'emma@fluux.chat' : STRESS_ROOM_JID
      if (kind === 'chat') await activateChat(page, jid)
      else await navigateToStressRoom(page)
      const id = `fastening-${kind}-${delay}`
      await page.evaluate(({ kind, jid, id }) => {
        const demo = window as unknown as DemoWindow
        const message = {
          id, stanzaId: undefined, originId: undefined, from: kind === 'chat' ? jid : `${jid}/PreviewBot`,
          body: 'https://example.com/fastening', timestamp: new Date(), isOutgoing: false,
        }
        if (kind === 'chat') demo.__demoClient.emitSDK('chat:message', {
          message: { ...message, type: 'chat', conversationId: jid }, isLiveArrival: true,
        })
        else demo.__demoClient.emitSDK('room:message', {
          roomJid: jid, message: { ...message, type: 'groupchat', roomJid: jid, nick: 'PreviewBot', occupantId: undefined }, isLiveArrival: true,
        })
      }, { kind, jid, id })
      await expect(page.locator(`.message-row[data-message-id="${id}"]`)).toBeVisible()
      // Ensure the original row is durable before deactivation evicts it.
      await expect.poll(() => page.evaluate(async ({ kind, jid, id }) => {
        const store = kind === 'chat' ? (window as unknown as DemoWindow).__chatStore : (window as unknown as DemoWindow).__roomStore
        const rows = await store.getState().loadMessagesFromCache(jid, { peek: true })
        return rows.some(row => row.id === id)
      }, { kind, jid, id })).toBe(true)
      await activateChat(page, 'ava@fluux.chat')
      await page.evaluate(async ({ kind, jid, id, delay }) => {
        const demo = window as unknown as DemoWindow
        const emit = () => {
          const updates = { linkPreview: { url: 'https://example.com/fastening', title: 'Durable fastening card' } }
          if (kind === 'chat') demo.__demoClient.emitSDK('chat:message-updated', { conversationId: jid, messageId: id, updates })
          else demo.__demoClient.emitSDK('room:message-updated', { roomJid: jid, messageId: id, updates })
        }
        const activate = async () => {
          if (kind === 'chat') await demo.__chatStore.getState().activateConversation(jid)
          else await demo.__roomStore.getState().activateRoom(jid)
          location.hash = `#/${kind === 'chat' ? 'messages' : 'rooms'}/${encodeURIComponent(jid)}`
        }
        if (delay === 'inactive') { emit(); await activate() }
        else {
          const activation = activate()
          if (delay) await new Promise(resolve => setTimeout(resolve, delay))
          emit()
          await activation
        }
      }, { kind, jid, id, delay })
      await expect(page.locator(`.message-row[data-message-id="${id}"]`).getByRole('link', { name: 'Durable fastening card' })).toBeVisible()
      await expect.poll(() => cachedPreview(page, kind, id)).toBe('Durable fastening card')
      await activateChat(page, 'ava@fluux.chat')
      if (kind === 'chat') await activateChat(page, jid)
      else await navigateToStressRoom(page)
      await expect(page.locator(`.message-row[data-message-id="${id}"]`).getByRole('link', { name: 'Durable fastening card' })).toBeVisible()
    })
  }
}
