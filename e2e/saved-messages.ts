import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { chatStore, roomStore, savedStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { waitForActions } from './harness/messageInteraction'
import { activateChat, navigateToStressRoom } from './harness/scrollHarness'
import { ROOM_JID as ROOM } from '../apps/fluux/src/demo/constants'

// Saved messages: save a room message and a chat message from the More menu, see them in the
// Saved view (central pane shows each in its conversation), open the highlighted original, and remove them. Demo history is the
// fixture; the private-node transport has its own unit tests and live two-client check.
const PEER = 'emma@fluux.chat'

/** Opens a conversation header's ⋮ menu and returns its Saved entry, which carries the count. */
async function savedEntry(page: Page, menuName: 'Room actions' | 'More actions') {
  await page.getByRole('button', { name: menuName, exact: true }).click()
  return page.getByRole('menu').getByRole('menuitem', { name: /^Saved messages \(/ })
}

async function openMore(page: Page, id: string) {
  const row = page.locator(`[data-message-id="${id}"][data-message-body]`)
  await row.scrollIntoViewIfNeeded()
  await page.mouse.move(1, 1)
  await page.mouse.move(0, 0)
  await row.hover()
  await waitForActions(page, id)
  await row.getByRole('button', { name: 'More options', exact: true }).click()
  return row
}

test('save a room message and a chat message, open them from Saved, remove them', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  const roomId = 'demo-room-whisper-pub'
  const body = await page.evaluate(async ({ roomJid, roomId }) => {
    const scope = window as unknown as { __demoClient: DemoClient; __roomStore: typeof roomStore }
    scope.__demoClient.stopAnimation()
    await scope.__roomStore.getState().activateRoom(roomJid)
    return scope.__roomStore.getState().messages.get(roomJid)!.find(row => row.id === roomId)!.body
  }, { roomJid: ROOM, roomId })

  // Nothing is saved yet: the room header is up (it has Search) but its ⋮ menu lists no Saved entry.
  await expect(page.getByRole('button', { name: 'Search in conversation' })).toBeVisible()
  await expect(await savedEntry(page, 'Room actions')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Save the room message.
  let row = await openMore(page, roomId)
  await row.getByRole('button', { name: 'Save message', exact: true }).click()
  await expect(page.locator(`[data-message-id="${roomId}"]`).getByRole('button', { name: 'Remove from saved', exact: true }).first()).toBeVisible()

  // A chat message with an archive id, delivered live.
  await page.evaluate(peer => {
    const scope = window as unknown as { __demoClient: DemoClient }
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id: 'saved-chat-1', conversationId: peer, from: peer, body: 'The door code is on the board',
      stanzaId: 'archive-saved-chat-1', originId: undefined, timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: true })
    location.hash = `#/messages/${encodeURIComponent(peer)}`
  }, PEER)
  // This chat has nothing saved yet, while the room does: no Saved entry here. Checked before
  // opening the message's actions, since opening the header menu closes them.
  await expect(page.getByRole('button', { name: 'Search in conversation' })).toBeVisible()
  await expect(await savedEntry(page, 'More actions')).toHaveCount(0)
  await page.keyboard.press('Escape')
  row = await openMore(page, 'saved-chat-1')
  await row.getByRole('button', { name: 'Save message', exact: true }).click()

  // The chat header's ⋮ menu shows only this conversation's count; it opens the Saved tab narrowed to it.
  const entry = await savedEntry(page, 'More actions')
  await expect(entry).toHaveText('Saved messages (1)')
  await entry.click()
  await expect(page).toHaveURL(/\/saved/)
  await expect(page.getByTestId('saved-row')).toHaveCount(1)
  await expect(page.getByTestId('saved-row')).toContainText('The door code is on the board')
  await expect(page.getByTestId('saved-scope')).toBeVisible()
  await expect(page.getByTestId('saved-private-note')).toHaveText('Only you see your saved messages')
  await expect(page.getByTestId('saved-conversation')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show all saved messages' }).click()
  await expect(page.getByTestId('saved-scope')).toHaveCount(0)
  await expect(page.getByTestId('saved-row')).toHaveCount(2)

  // Choosing a row of the narrowed list opens the message highlighted in this conversation.
  await (await savedEntry(page, 'More actions')).click()
  await expect(page.getByTestId('saved-row')).toHaveCount(1)
  await page.getByTestId('saved-row').click()
  await expect(page.locator('[data-message-id="saved-chat-1"].message-highlight')).toBeInViewport()

  // Two more entries, older than the others, for the read-only checks below: a chat with unread messages
  // and its own read pointer, and a room that is not in the room list and has no history on this device.
  const OTHER_PEER = 'unread-peer@fluux.chat'
  const GHOST_ROOM = 'ghost-room@conference.fluux.chat'
  await page.evaluate(({ peer, ghost }) => {
    const scope = window as unknown as { __demoClient: DemoClient; __savedStore: typeof savedStore; __chatStore: typeof chatStore }
    scope.__chatStore.getState().addConversation({ id: peer, name: 'Unread Peer', type: 'chat', unreadCount: 3, mentionsCount: 0 } as Parameters<ReturnType<typeof chatStore.getState>['addConversation']>[0])
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id: 'unread-1', conversationId: peer, from: peer, body: 'Unread while you read Saved',
      stanzaId: 'archive-unread-1', originId: undefined, timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: true })
    scope.__savedStore.getState().save({
      id: 'unread-entry', conversationJid: peer, type: 'chat', from: peer, text: 'Unread while you read Saved',
      savedAt: 2, sentAt: Date.now(), messageId: 'unread-1', stanzaId: 'archive-unread-1',
    })
    scope.__savedStore.getState().save({
      id: 'ghost-entry', conversationJid: ghost, type: 'groupchat', from: `${ghost}/Al`, text: 'Saved from a room I never joined here',
      savedAt: 1, sentAt: Date.now() - 86_400_000, stanzaId: 'archive-ghost-1', stanzaIdBy: ghost,
    })
  }, { peer: OTHER_PEER, ghost: GHOST_ROOM })

  // Browsing is read-only: it must not join, ask the server for history, activate a conversation or move a read pointer.
  // The recorder is installed before Saved is opened, so the initial preview is covered too.
  await page.evaluate(() => {
    const client = (window as unknown as { __demoClient: Record<string, Record<string, unknown>> }).__demoClient
    const calls: string[] = []
    ;(window as unknown as { __sdkCalls: string[] }).__sdkCalls = calls
    for (const namespace of ['rooms', 'messages']) {
      const target = client[namespace]
      if (!target) continue
      const names = new Set([...Object.getOwnPropertyNames(Object.getPrototypeOf(target)), ...Object.keys(target)])
      for (const name of names) {
        const original = target[name]
        if (name === 'constructor' || typeof original !== 'function') continue
        target[name] = (...args: unknown[]) => { calls.push(`${namespace}.${name}`); return (original as (...a: unknown[]) => unknown).apply(target, args) }
      }
    }
  })
  const readState = () => page.evaluate(({ room, peer, other, ghost }) => {
    const scope = window as unknown as { __roomStore: typeof roomStore; __chatStore: typeof chatStore }
    const rooms = scope.__roomStore.getState()
    const chats = scope.__chatStore.getState()
    const roomState = rooms.rooms.get(room)
    return {
      active: { room: rooms.activeRoomJid, chat: chats.activeConversationId },
      read: {
      room: { joined: roomState?.joined, unread: roomState?.unreadCount, mentions: roomState?.mentionsCount, pointer: JSON.stringify(roomState?.readPointer ?? null) },
      chat: { unread: chats.conversations.get(peer)?.unreadCount, pointer: JSON.stringify(chats.conversations.get(peer)?.readPointer ?? null) },
      otherChat: { unread: chats.conversations.get(other)?.unreadCount, pointer: JSON.stringify(chats.conversations.get(other)?.readPointer ?? null) },
      ghostRoom: rooms.rooms.has(ghost),
      },
    }
  }, { room: ROOM, peer: PEER, other: OTHER_PEER, ghost: GHOST_ROOM })

  // The read-state baseline is taken before Saved is opened, so nothing done on entry is absorbed into it.
  const before = await readState()
  expect(before.read.otherChat.unread).toBeGreaterThan(0)
  expect(before.read.ghostRoom).toBe(false)

  // Entries appear in Saved, newest saved first.
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await expect(page).toHaveURL(/\/saved/)
  const rows = page.getByTestId('saved-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.first()).toContainText('The door code is on the board')
  await expect(rows.nth(1)).toContainText(body.slice(0, 20))
  // Opening the tab closed the open conversation; browsing opens none.
  expect((await readState()).active).toEqual({ room: null, chat: null })

  // The central pane opens the newest entry inside its conversation, read-only, with the message highlighted.
  const preview = page.getByTestId('saved-preview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('[data-message-id="saved-chat-1"].message-highlight-persistent')).toBeInViewport()
  await expect(page.getByText('Select a saved message')).toHaveCount(0)

  // A click on another row shows that entry in the pane without leaving Saved.
  await rows.nth(1).click()
  await expect(page).toHaveURL(/\/saved/)
  await expect(preview.locator(`[data-message-id="${roomId}"].message-highlight-persistent`)).toBeInViewport()
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true')

  // An unread chat, and a saved room message with no history here and no room in the list: the pane shows the saved copy.
  await rows.nth(2).click()
  await expect(preview.locator('[data-message-id="unread-1"].message-highlight-persistent')).toBeInViewport()
  await rows.nth(3).click()
  await expect(page.getByTestId('saved-copy-only')).toContainText('Saved from a room I never joined here')
  await expect(page).toHaveURL(/\/saved/)

  // Browsing cache-hit and saved-copy entries left joins, counters and read pointers as they were, and called nothing on the rooms or messages APIs.
  const after = await readState()
  expect(after.read).toEqual(before.read)
  expect(after.active).toEqual({ room: null, chat: null })
  expect(await page.evaluate(() => (window as unknown as { __sdkCalls: string[] }).__sdkCalls)).toEqual([])
  await page.evaluate(() => {
    const scope = window as unknown as { __savedStore: typeof savedStore }
    scope.__savedStore.getState().remove('unread-entry')
    scope.__savedStore.getState().remove('ghost-entry')
  })
  await expect(rows).toHaveCount(2)
  await rows.nth(1).click()

  // A click on the highlighted message opens the room conversation with the original highlighted.
  await preview.locator(`[data-message-id="${roomId}"].message-highlight-persistent`).click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${encodeURIComponent(ROOM)}$`))
  await expect(page.locator(`[data-message-id="${roomId}"].message-highlight`)).toBeInViewport()
  await expect(await savedEntry(page, 'Room actions')).toHaveText('Saved messages (1)')
  await page.keyboard.press('Escape')

  // Go to message opens the chat entry (the newest, shown on arrival) in its conversation.
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await page.getByTestId('saved-preview').getByRole('button', { name: 'Go to message' }).click()
  await expect(page).toHaveURL(new RegExp(`/messages/${encodeURIComponent(PEER)}$`))
  await expect(page.locator('[data-message-id="saved-chat-1"].message-highlight')).toBeInViewport()

  // A double-click on a row opens its conversation too.
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await page.getByTestId('saved-row').nth(1).dblclick()
  await expect(page).toHaveURL(new RegExp(`/rooms/${encodeURIComponent(ROOM)}$`))

  // Remove both from the list; the empty state says how to save one.
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await page.getByTestId('saved-row').first().getByRole('button', { name: 'Remove from saved' }).click()
  await expect(page.getByTestId('saved-row')).toHaveCount(1)
  await page.getByTestId('saved-row').first().getByRole('button', { name: 'Remove from saved' }).click()
  await expect(page.getByText('No saved messages')).toBeVisible()
  await expect(page.getByTestId('saved-zero-pane')).toBeVisible()
  expect(page.context().pages()).toHaveLength(1)
})

test('a locked Saved list shows the unlock explanation instead of the zero pane, then the zero pane once unlocked', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/messages/${encodeURIComponent(PEER)}`)
  await activateChat(page, PEER)
  // Disposable demo state: the list holds one sealed item and no readable entry; no key or account is involved.
  await page.evaluate(() => {
    const scope = window as unknown as { __savedStore: typeof savedStore }
    scope.__savedStore.setState({ sealState: 'locked', lockedIds: { 'sealed-1': true }, entries: {}, loaded: true })
  })
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await expect(page.getByTestId('saved-locked-pane')).toBeVisible()
  const pane = page.getByTestId('saved-locked-pane')
  await expect(pane.getByRole('heading', { name: 'Saved messages are locked' })).toBeVisible()
  await expect(pane.getByText('Unlock your key to read them.')).toBeVisible()
  await expect(page.getByTestId('saved-zero-pane')).toHaveCount(0)
  await expect(page.getByTestId('saved-row')).toHaveCount(0)
  await page.screenshot({ path: process.env.SAVED_LOCKED_PICTURE ?? 'test-results/saved-locked.png' })
  // Once nothing is sealed any more the ordinary zero pane takes over.
  await page.evaluate(() => {
    const scope = window as unknown as { __savedStore: typeof savedStore }
    scope.__savedStore.setState({ sealState: 'unavailable', lockedIds: {} })
  })
  await expect(page.getByTestId('saved-zero-pane')).toBeVisible()
  await expect(page.getByTestId('saved-locked-pane')).toHaveCount(0)
})

test('a pending outgoing message offers no Save', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  await activateChat(page, PEER)
  await page.evaluate(peer => {
    const scope = window as unknown as { __demoClient: DemoClient }
    scope.__demoClient.stopAnimation()
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id: 'pending-out', conversationId: peer, from: 'you@fluux.chat', body: 'sending…',
      stanzaId: undefined, originId: undefined, timestamp: new Date(), isOutgoing: true,
    }, isLiveArrival: true })
  }, PEER)
  const row = page.locator('[data-message-id="pending-out"][data-message-body]')
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await expect(row.getByRole('button', { name: 'Save message', exact: true })).toHaveCount(0)
})

test('pressing Enter on Remove removes the entry and does not open the original', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  await activateChat(page, PEER)
  await page.evaluate(peer => {
    const scope = window as unknown as { __demoClient: DemoClient }
    scope.__demoClient.stopAnimation()
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id: 'saved-kb-1', conversationId: peer, from: peer, body: 'Keyboard removal check',
      stanzaId: 'archive-saved-kb-1', originId: undefined, timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: true })
  }, PEER)
  const row = await openMore(page, 'saved-kb-1')
  await row.getByRole('button', { name: 'Save message', exact: true }).click()
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await expect(page).toHaveURL(/\/saved/)
  await page.getByTestId('saved-row').first().getByRole('button', { name: 'Remove from saved' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('No saved messages')).toBeVisible()
  await expect(page).toHaveURL(/\/saved/)
})

test('on a phone the header button shows the narrowed list and Back from a row returns to the Saved list', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await page.setViewportSize({ width: 390, height: 844 })
  await bootDemo(page, `/demo.html?tutorial=false#/messages/${encodeURIComponent(PEER)}`)
  await activateChat(page, PEER)
  await page.evaluate(peer => {
    const scope = window as unknown as { __demoClient: DemoClient; __savedStore: typeof savedStore }
    scope.__demoClient.stopAnimation()
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id: 'saved-phone-1', conversationId: peer, from: peer, body: 'Phone saved check',
      stanzaId: 'archive-saved-phone-1', originId: undefined, timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: true })
    scope.__savedStore.getState().save({
      id: 'phone1', conversationJid: peer, type: 'chat', from: peer, text: 'Phone saved check',
      savedAt: Date.now(), sentAt: Date.now(), messageId: 'saved-phone-1', stanzaId: 'archive-saved-phone-1',
    })
    scope.__savedStore.getState().save({
      id: 'phone2', conversationJid: 'room@conference.example', type: 'groupchat', from: 'room@conference.example/Al', text: 'Elsewhere',
      savedAt: Date.now() - 1000, stanzaId: 'archive-elsewhere', stanzaIdBy: 'room@conference.example',
    })
  }, PEER)

  // On a phone the header collapses the button into the More actions menu; it opens the narrowed list instead of leaving the chat on screen.
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Saved messages (1)', exact: true }).click()
  await expect(page).toHaveURL(/\/saved/)
  await expect(page.getByTestId('saved-scope')).toBeVisible()
  await expect(page.getByTestId('saved-row')).toHaveCount(1)

  // Opening the row shows the conversation; Back returns to the narrowed list.
  await page.getByTestId('saved-row').click()
  await expect(page).toHaveURL(new RegExp(`/messages/${encodeURIComponent(PEER)}$`))
  await page.goBack()
  await expect(page).toHaveURL(/\/saved/)
  // Leaving the Saved tab ended the narrowing: Back shows the full list.
  await expect(page.getByTestId('saved-row')).toHaveCount(2)
  await expect(page.getByTestId('saved-scope')).toHaveCount(0)
})

test('removing the last saved message of the narrowed conversation shows the full list', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  await activateChat(page, PEER)
  await page.evaluate(peer => {
    const scope = window as unknown as { __demoClient: DemoClient; __savedStore: typeof savedStore }
    scope.__demoClient.stopAnimation()
    scope.__savedStore.getState().save({
      id: 'only1', conversationJid: peer, type: 'chat', from: peer, text: 'The only one here',
      savedAt: Date.now(), sentAt: Date.now(), messageId: 'saved-only-1', stanzaId: 'archive-only-1',
    })
    scope.__savedStore.getState().save({
      id: 'other1', conversationJid: 'room@conference.example', type: 'groupchat', from: 'room@conference.example/Al', text: 'Elsewhere',
      savedAt: Date.now() - 1000, stanzaId: 'archive-elsewhere', stanzaIdBy: 'room@conference.example',
    })
  }, PEER)
  await (await savedEntry(page, 'More actions')).click()
  await expect(page.getByTestId('saved-scope')).toBeVisible()
  await expect(page.getByTestId('saved-row')).toHaveCount(1)
  await page.getByTestId('saved-row').getByRole('button', { name: 'Remove from saved' }).click()
  await expect(page.getByTestId('saved-scope')).toHaveCount(0)
  await expect(page.getByTestId('saved-row')).toHaveCount(1)
  await expect(page.getByTestId('saved-row')).toContainText('Elsewhere')
})

// A stale marker must remove only: the menu toggle can save again.
async function seedMarker(page: Page, kind: 'chat' | 'room') {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  if (kind === 'chat') await activateChat(page, PEER)
  else await navigateToStressRoom(page, false, ROOM)
  const target = await page.evaluate(({ kind, peer, room }) => {
    const scope = window as unknown as { __demoClient: DemoClient; __roomStore: typeof roomStore; __savedStore: typeof savedStore }
    scope.__demoClient.stopAnimation()
    const id = kind === 'chat' ? 'marker-checklist' : 'demo-room-whisper-pub'
    const jid = kind === 'chat' ? peer : room
    if (kind === 'chat') {
      for (const [id, body] of [['marker-checklist', 'The checklist is ready.'], ['marker-other', 'Keep this saved too.']]) {
        scope.__demoClient.emitSDK('chat:message', { message: {
          type: 'chat', id, conversationId: peer, from: peer, body, stanzaId: `archive-${id}`, originId: undefined,
          timestamp: new Date(), isOutgoing: false,
        }, isLiveArrival: true })
      }
    }
    const messages = kind === 'chat' ? [
      { id, from: peer, body: 'The checklist is ready.', stanzaId: `archive-${id}`, timestamp: new Date() },
      { id: 'marker-other', from: peer, body: 'Keep this saved too.', stanzaId: 'archive-marker-other', timestamp: new Date() },
    ] : (() => {
      const rows = scope.__roomStore.getState().messages.get(room)!
      return [rows.find(m => m.id === id)!, rows.find(m => m.id !== id && !m.isPrivate && !!m.body && !!m.stanzaId)!]
    })()
    scope.__savedStore.getState().reconcileFetch(messages.map((m, i) => ({
      id: `marker-entry-${i}`, conversationJid: jid, type: kind === 'chat' ? 'chat' : 'groupchat',
      from: m.from, text: m.body, savedAt: 2000 - i, sentAt: m.timestamp.getTime(),
      messageId: m.id, stanzaId: m.stanzaId, ...(kind === 'room' ? { stanzaIdBy: room } : {}),
    })))
    return { id, body: messages[0].body, otherId: messages[1].id }
  }, { kind, peer: PEER, room: ROOM })
  const row = page.locator(`[data-message-id="${target.id}"][data-message-body]`)
  await row.scrollIntoViewIfNeeded()
  await expect(row.getByTestId('saved-marker')).toBeVisible()
  return { ...target, row, marker: row.getByRole('button', { name: 'Remove from saved', exact: true }) }
}

for (const kind of ['chat', 'room'] as const) {
  for (const activation of ['mouse', 'Enter', 'Space'] as const) {
    test(`${kind} bookmark removes only its save with ${activation} and retains focus and reader position`, async ({ page }) => {
      const { row, marker, body, otherId } = await seedMarker(page, kind)
      await expect(await savedEntry(page, kind === 'chat' ? 'More actions' : 'Room actions')).toHaveText('Saved messages (2)')
      await page.keyboard.press('Escape')
      await marker.focus()
      const zone = page.locator('.focus-zone').filter({ has: row })
      const top = await row.evaluate(el => el.getBoundingClientRect().top)
      if (activation === 'mouse') await marker.click()
      else await marker.press(activation)
      await expect(row.getByTestId('saved-marker')).toHaveCount(0)
      await expect(row).toContainText(body)
      await expect(zone).toBeFocused()
      await expect.poll(() => row.evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(top, 0)
      await expect(await savedEntry(page, kind === 'chat' ? 'More actions' : 'Room actions')).toHaveText('Saved messages (1)')
      await page.keyboard.press('Escape')
      expect(await page.evaluate(() => Object.keys((window as unknown as { __savedStore: typeof savedStore }).__savedStore.getState().entries))).toEqual(['marker-entry-1'])
      await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
      await expect(page.getByTestId('saved-row')).toHaveCount(1)
      const preview = page.getByTestId('saved-preview')
      await expect(preview.locator(`[data-message-id="${otherId}"]`).getByRole('img', { name: 'Saved', exact: true })).toBeVisible()
      await expect(preview.locator('button[data-testid="saved-marker"]')).toHaveCount(0)
    })
  }

  test(`${kind} marker refusal restores the entry, count and existing error`, async ({ page }) => {
    const { row, marker, body } = await seedMarker(page, kind)
    // Hold the actual demo retract response: a later store refusal can follow an already settled success.
    await page.evaluate(() => {
      type Stanza = { attrs: Record<string, string>; getChild(name: string): Stanza | undefined }
      const scope = window as unknown as {
        __demoClient: { beginIQSend(stanza: Stanza): Promise<unknown> }
        __rejectSavedRemoval?: () => void
      }
      const client = scope.__demoClient
      const send = client.beginIQSend
      client.beginIQSend = stanza => {
        const item = stanza.getChild('pubsub')?.getChild('retract')?.getChild('item')
        if (item?.attrs.id !== 'marker-entry-0') return send.call(client, stanza)
        return new Promise<never>((_resolve, reject) => {
          scope.__rejectSavedRemoval = () => {
            client.beginIQSend = send
            delete scope.__rejectSavedRemoval
            reject(Object.assign(new Error('Demo removal refused'), { name: 'StanzaError' }))
          }
        })
      }
    })
    await marker.click()
    await expect(row.getByTestId('saved-marker')).toHaveCount(0)
    await page.waitForFunction(() => typeof (window as unknown as { __rejectSavedRemoval?: () => void }).__rejectSavedRemoval === 'function')
    expect(await page.evaluate(() => {
      const state = (window as unknown as { __savedStore: typeof savedStore }).__savedStore.getState()
      return { pending: state.pending['marker-entry-0'], retained: !!state.removed['marker-entry-0'] }
    })).toEqual({ pending: 'retract', retained: true })
    await page.evaluate(() => (window as unknown as { __rejectSavedRemoval: () => void }).__rejectSavedRemoval())
    await expect(marker).toBeVisible()
    await expect(row).toContainText(body)
    await expect(page.getByText('Your server refused to store this message.')).toBeVisible()
    await expect(await savedEntry(page, kind === 'chat' ? 'More actions' : 'Room actions')).toHaveText('Saved messages (2)')
    await page.keyboard.press('Escape')
    await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
    await expect(page.getByTestId('saved-row')).toHaveCount(2)
  })
}

test.describe('touch bookmark target', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  for (const kind of ['chat', 'room'] as const) {
    test(`${kind} tap removes a save with a separate 44 px target`, async ({ page, browserName }) => {
      const { row, marker, body } = await seedMarker(page, kind)
      const box = await marker.boundingBox()
      expect(box!.width).toBe(44)
      expect(box!.height).toBe(44)
      const icon = await marker.locator('svg').boundingBox()
      expect(icon!.width).toBe(12)
      expect(icon!.height).toBe(12)
      const column = await row.locator('[data-msg-column]').boundingBox()
      expect(column!.x + column!.width).toBeLessThanOrEqual(box!.x)
      if (browserName === 'chromium') {
        const input = await page.context().newCDPSession(page)
        const x = box!.x + 22, y = box!.y + 22
        await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 80 }] })
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await input.detach()
        await expect(marker).toBeVisible()
      }
      await marker.tap()
      await expect(row.getByTestId('saved-marker')).toHaveCount(0)
      await expect(row).toContainText(body)
      expect(await page.evaluate(() => Object.keys((window as unknown as { __savedStore: typeof savedStore }).__savedStore.getState().entries))).toEqual(['marker-entry-1'])
    })
  }
})

test('compact RTL bookmark has its own 24 px slot, visible keyboard focus, and no mouse drag action', async ({ page }) => {
  const { otherId } = await seedMarker(page, 'chat')
  const row = page.locator(`[data-message-id="${otherId}"][data-message-body]`)
  const marker = row.getByRole('button', { name: 'Remove from saved', exact: true })
  await row.scrollIntoViewIfNeeded()
  await page.evaluate(() => {
    const scope = window as unknown as { __settingsStore: { setState(value: { densityMode: string }): void } }
    scope.__settingsStore.setState({ densityMode: 'compact' })
    document.documentElement.dir = 'rtl'
  })
  const box = await marker.boundingBox()
  expect(box!.width).toBe(24)
  expect(box!.height).toBe(24)
  const column = await row.locator('[data-msg-column]').boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(column!.x)
  const rowBox = await row.boundingBox()
  expect(rowBox!.height).toBeGreaterThanOrEqual(24)
  await row.hover()
  const overlaps = await row.evaluate(el => {
    const marker = el.querySelector('[data-testid="saved-marker"]')!.getBoundingClientRect()
    return [...el.querySelectorAll('[data-message-toolbar] button')].some(button => {
      const rect = button.getBoundingClientRect()
      return rect.left < marker.right && rect.right > marker.left && rect.top < marker.bottom && rect.bottom > marker.top
    })
  })
  expect(overlaps).toBe(false)
  await page.mouse.move(box!.x + 12, box!.y + 12)
  await page.mouse.down()
  await page.mouse.move(box!.x + 100, box!.y, { steps: 5 })
  await page.mouse.up()
  await expect(marker).toBeVisible()
  // Tab cycles app focus zones rather than the controls inside each zone.
  await page.keyboard.press('Tab')
  await marker.focus()
  await expect(marker).toBeFocused()
  expect(await marker.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none')
  const top = await row.evaluate(el => el.getBoundingClientRect().top)
  await marker.press('Space')
  await expect(row.getByTestId('saved-marker')).toHaveCount(0)
  await expect.poll(() => row.evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(top, 0)
})

test('removing the last timeline bookmark removes the header count without deleting either message', async ({ page }) => {
  const { row, marker, otherId } = await seedMarker(page, 'chat')
  await marker.click()
  const other = page.locator(`[data-message-id="${otherId}"][data-message-body]`)
  await other.getByRole('button', { name: 'Remove from saved', exact: true }).click()
  await expect(row).toContainText('The checklist is ready.')
  await expect(other).toContainText('Keep this saved too.')
  await expect(await savedEntry(page, 'More actions')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await expect(page.getByTestId('saved-zero-pane')).toBeVisible()
})

test('Search keeps the saved bookmark passive', async ({ page }) => {
  const { id } = await seedMarker(page, 'room')
  // Live demo rows are not an awaited search-index fixture; persist/index the actual target first.
  expect(await page.evaluate(async ({ room, id }) => {
    const state = (window as unknown as { __roomStore: typeof roomStore }).__roomStore.getState()
    const target = state.messages.get(room)?.find(message => message.id === id)
    if (!target) throw new Error('Search fixture target is missing')
    return state.saveMessageLinkContext(room, [target])
  }, { room: ROOM, id })).toBe(true)
  await page.getByRole('button', { name: 'Search in conversation', exact: true }).click()
  await page.getByPlaceholder('Search messages…').fill('remaining review tasks')
  await page.getByText("I'll go through the remaining review tasks this afternoon", { exact: false }).first().click()
  const previewRow = page.locator(`[data-message-id="${id}"][data-message-body]`)
  await expect(previewRow.getByRole('img', { name: 'Saved', exact: true })).toBeVisible()
  await expect(previewRow.locator('button[data-testid="saved-marker"]')).toHaveCount(0)
  expect(await page.evaluate(() => Object.keys((window as unknown as { __savedStore: typeof savedStore }).__savedStore.getState().entries))).toEqual(['marker-entry-0', 'marker-entry-1'])
})
