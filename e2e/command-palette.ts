import { DRAFT_SAVE_DELAY_MS } from '../apps/fluux/src/constants/ui'
import { expect, test, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { bootDemo } from './harness/demoBoot'

for (const width of [1280, 390]) {
  test(`Cmd-K finds the open conversation by contact name at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
    await bootDemo(page, '/demo.html?tutorial=false')
    await page.evaluate(() => {
      const demo = window as unknown as { __demoClient: DemoClient }
      const client = demo.__demoClient
      client.stopAnimation()
      client.emitSDK('contacts:loaded', { contacts: [
        { jid: 'person42@example.test', name: 'Babette', presence: 'online', subscription: 'both' },
        { jid: 'person43@example.test', name: 'Babette Dupont', presence: 'offline', subscription: 'both' },
      ] })
      for (const [id, name, body] of [
        ['person42@example.test', 'Babette', 'Hello'],
        ['other@example.test', 'Other Person', 'Ask bab about lunch'],
      ]) {
        client.emitSDK('chat:conversation', { conversation: { id, name, type: 'chat', unreadCount: 0 } })
        client.emitSDK('chat:message', { message: {
          id: `fixture-${id}`, stanzaId: undefined, originId: undefined, conversationId: id, from: id, body,
          timestamp: new Date(), type: 'chat', isOutgoing: false,
        }, isLiveArrival: false })
      }
    })
    await page.locator('[data-nav="messages"]').click()
    await page.getByRole('complementary').getByText('Babette', { exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Babette', exact: true })).toBeVisible()
    // Keep row reflow from turning the parked pointer into a mouse selection.
    await page.mouse.move(0, 0)
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    const input = palette.getByRole('textbox')
    await expect(input).toBeFocused()
    // The open thread stays out of empty-query suggestions.
    await expect(palette.getByRole('button', { name: /Babette person42/ })).toHaveCount(0)
    for (const query of ['bab', '@BAB', 'bette', '@ette', 'person42']) {
      await input.fill(query)
      const current = palette.getByRole('button', { name: /Babette person42/ })
      await expect(current).toHaveCount(1)
      await expect(current.locator('..').locator('.command-group-label')).toHaveText('Messages')
    }
    await input.fill('bab')
    const rows = palette.getByRole('button')
    await expect(palette.getByRole('button', { name: /Other Person/ })).toHaveCount(1)
    await expect(palette.getByRole('button', { name: /Search messages for "bab"/ })).toHaveCount(1)
    await expect(palette.getByRole('button', { name: /Babette Dupont/ }).locator('..').locator('.command-group-label')).toHaveText('Contacts')

    // Assert the rendered field and results occupy separate space on both widths.
    const field = await palette.locator('.command-search-field').boundingBox()
    const first = await rows.first().boundingBox()
    expect(first!.y).toBeGreaterThanOrEqual(field!.y + field!.height)
    const panel = await palette.boundingBox()
    expect(panel!.x).toBeGreaterThanOrEqual(0)
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: test.info().outputPath('contact-search.png') })

    await input.fill('person42')
    await expect(palette.getByRole('button', { name: /Babette person42/ })).toHaveAttribute('data-selected', 'true')
    await input.press('Enter')
    await expect(palette).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Babette', exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await input.fill('@bab')
    await palette.getByRole('button', { name: /Babette Dupont/ }).click()
    await expect(palette).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Babette Dupont', exact: true })).toBeVisible()
  })
}

for (const width of [1280, 390]) {
  test(`Drafts resumes local chat and room composers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
    await bootDemo(page, '/demo.html?tutorial=false')
    await page.evaluate(() => (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation())
    await page.locator('[data-nav="messages"]').click()
    await page.getByRole('complementary').getByText('Emma Wilson', { exact: true }).click()
    const chatField = page.getByPlaceholder('Message Emma Wilson', { exact: true })
    await chatField.fill('I can bring the revised drawings on Thursday.')
    if (width < 768) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
    await page.locator('[data-nav="rooms"]').click()
    await page.getByRole('complementary').getByText('Design Review', { exact: true }).click()
    const roomField = page.locator('.message-input[contenteditable="true"]').first()
    await expect(roomField).toHaveAttribute('aria-placeholder', 'Message #Design Review')
    await roomField.fill('Can we review the updated spacing together?')
    await page.mouse.move(0, 0)
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    const input = palette.getByRole('textbox')
    await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveAttribute('data-selected', 'true')
    if (process.env.FLUUX_DRAFT_PROOF) {
      await page.screenshot({ path: test.info().outputPath('draft-entry.png'), animations: 'disabled' })
    }
    await input.press('Enter')
    await expect(input).toHaveAttribute('placeholder', 'Find a draft…')
    await expect(palette.getByRole('button', { name: /Emma Wilson emma/ })).toBeVisible()
    await expect(palette.getByRole('button', { name: /Design Review design/ })).toBeVisible()
    await expect(palette).not.toContainText('revised drawings')
    await expect(palette).not.toContainText('updated spacing')
    const observedNames = await palette.getByRole('button').allTextContents()
    if (process.env.FLUUX_DRAFT_PROOF) {
      await page.screenshot({ path: test.info().outputPath('draft-list.png'), animations: 'disabled' })
    }
    await palette.getByRole('button', { name: /Emma Wilson emma/ }).focus()
    await expect(palette.getByRole('button', { name: /Emma Wilson emma/ })).toHaveAttribute('data-selected', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(input).toBeFocused()
    await expect(palette.getByRole('button', { name: /Design Review design/ })).toHaveAttribute('data-selected', 'true')
    await input.press('Enter')
    await expect(palette).toBeHidden()
    await expect(roomField).toHaveText('Can we review the updated spacing together?')
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette).toBeVisible()
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await input.fill('updated spacing')
    await expect(palette.getByText('No results found')).toBeVisible()
    await expect(palette.getByRole('button', { name: /Search messages/ })).toHaveCount(0)
    await palette.getByRole('button', { name: /Back/ }).focus()
    await page.keyboard.press('Enter')
    await expect(input).toHaveAttribute('placeholder', 'Go to...')
    await input.fill('emma')
    await expect(palette.getByRole('button', { name: /Emma Wilson emma/ })).toBeVisible()
    await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
    await input.fill('')
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await expect(input).toBeFocused()
    await input.fill('emma')
    await palette.getByRole('button', { name: /Emma Wilson emma/ }).focus()
    await page.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    await expect(chatField).toHaveValue('I can bring the revised drawings on Thursday.')
    const restoredChat = await chatField.inputValue()
    await page.goBack()
    await expect(roomField).toHaveText('Can we review the updated spacing together?')
    await page.goForward()
    await expect(chatField).toHaveValue('I can bring the revised drawings on Thursday.')
    await chatField.fill('')
    await page.keyboard.press('ControlOrMeta+k')
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await expect(palette.getByRole('button', { name: /Emma Wilson emma/ })).toHaveCount(0)
    await palette.getByRole('button', { name: /Design Review design/ }).click()
    await expect(palette).toBeHidden()
    await expect(roomField).toHaveText('Can we review the updated spacing together?')
    const restoredRoom = await roomField.textContent()
    if (width < 768) await page.getByRole('button', { name: 'Send', exact: true }).click()
    else await roomField.press('Enter')
    await expect(roomField).toHaveText('')
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette).toBeVisible()
    await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await roomField.press('ArrowUp')
    await expect(page.getByText('Editing message', { exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette).toBeVisible()
    await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await roomField.press('Escape')
    await expect(page.getByText('Editing message', { exact: true })).toHaveCount(0)
    await page.evaluate(() => {
      const demo = window as unknown as { __connectionStore: typeof import('@fluux/sdk/stores').connectionStore }
      demo.__connectionStore.getState().setHttpUploadService({ jid: 'upload.fluux.chat', maxFileSize: 10_000_000 })
    })
    await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/media/landscape-1280x720.jpg')
    await expect(page.getByRole('button', { name: 'Remove attachment', exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette).toBeVisible()
    await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
    const stagedFileDraftEntries = await palette.getByRole('button', { name: /^Drafts/ }).count()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await page.getByRole('button', { name: 'Remove attachment', exact: true }).click()
    await roomField.fill('Continue at the next review.')
    await page.keyboard.press('ControlOrMeta+k')
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await expect(palette.getByRole('button', { name: /Design Review design/ })).toBeVisible()
    await page.evaluate(() => {
      const demo = window as unknown as {
        __chatStore: typeof import('@fluux/sdk/stores').chatStore
        __roomStore: typeof import('@fluux/sdk/stores').roomStore
      }
      localStorage.setItem('xmpp-chat-storage:second@example.test', JSON.stringify({ state: {
        conversations: [['colleague@example.test', { id: 'colleague@example.test', name: 'Second account colleague', type: 'chat', unreadCount: 0 }]],
        archivedConversations: [],
        drafts: [['colleague@example.test', 'I will send the updated agenda.']],
      } }))
      demo.__chatStore.getState().switchAccount('second@example.test')
      demo.__roomStore.getState().switchAccount('second@example.test')
    })
    await expect(palette.getByRole('button', { name: /Design Review design/ })).toHaveCount(0)
    await expect(palette.getByRole('button', { name: /Emma Wilson emma/ })).toHaveCount(0)
    await expect(palette.getByRole('button', { name: /Second account colleague/ })).toBeVisible()
    const namesAfterAccountHydration = await palette.getByRole('button').allTextContents()
    await test.info().attach('draft-journey', {
      body: JSON.stringify({ width, observedNames, restoredChat, restoredRoom, stagedFileDraftEntries, namesAfterAccountHydration }),
      contentType: 'application/json',
    })
  })
}


async function enterWhisper(page: Page, nick = 'Emma') {
  const showMembers = page.getByRole('button', { name: 'Show members', exact: true })
  await expect(page.getByRole('button', { name: /^(Show|Hide) members$/ })).toBeVisible()
  if (await showMembers.isVisible()) await showMembers.click()
  await page.locator('.touch-menu-row').filter({ hasText: nick }).first().click({ button: 'right' })
  await page.getByRole('button', { name: 'Whisper', exact: true }).click()
  await expect(page.getByText(`Whispering privately to ${nick}`, { exact: true })).toBeVisible()
  return page.getByRole('combobox', { name: `Whisper to ${nick}...`, exact: true })
}

test('private whispers never become discoverable public drafts after a composer remount', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation())
  await page.locator('[data-nav="rooms"]').click()
  await page.getByRole('complementary').getByText('Team Chat', { exact: true }).click()
  const publicField = page.getByRole('combobox', { name: 'Message #Team Chat', exact: true })
  await expect(publicField).toBeVisible()
  await page.clock.install()
  const liveWhisperStates: { ordinaryText: string; privateText: string | null; rows: string[] }[] = []
  for (const ordinary of ['', 'Public agenda for the next review.']) {
    await publicField.fill(ordinary)
    const privateField = await enterWhisper(page)
    await expect(privateField).toHaveText('')
    await privateField.fill('Please keep the staffing discussion between us.')
    await page.clock.runFor(DRAFT_SAVE_DELAY_MS + 1)
    await page.clock.resume()
    expect(await page.evaluate(() => {
      const demo = window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }
      return demo.__roomStore.getState().getDraft('team@conference.fluux.chat')
    })).toBe(ordinary)
    await page.keyboard.press('ControlOrMeta+k')
    const activeFinder = page.getByRole('dialog')
    await expect(activeFinder).toBeVisible()
    if (ordinary) {
      await activeFinder.getByRole('button', { name: /^Drafts/ }).click()
      await expect(activeFinder.getByRole('button', { name: /Team Chat team/ })).toBeVisible()
    } else await expect(activeFinder.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
    await expect(activeFinder).not.toContainText('staffing discussion')
    liveWhisperStates.push({
      ordinaryText: await page.evaluate(() => (window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }).__roomStore.getState().getDraft('team@conference.fluux.chat')),
      privateText: await privateField.textContent(),
      rows: await activeFinder.getByRole('button').allTextContents(),
    })
    await page.keyboard.press('Escape')
    await expect(activeFinder).toBeHidden()
    await expect(privateField).toHaveText('Please keep the staffing discussion between us.')
    await page.locator('[data-nav="rooms"]').click()
    await page.getByRole('complementary').getByText('Design Review', { exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Message #Design Review', exact: true })).toBeVisible()
    expect(await page.evaluate(() => {
      const demo = window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }
      return demo.__roomStore.getState().getDraft('team@conference.fluux.chat')
    })).toBe(ordinary)
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    await expect(palette).toBeVisible()
    if (ordinary) {
      await palette.getByRole('button', { name: /^Drafts/ }).click()
      await palette.getByRole('button', { name: /Team Chat team/ }).click()
    } else {
      await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(palette).toBeHidden()
      await page.getByRole('complementary').getByText('Team Chat', { exact: true }).click()
    }
    await expect(publicField).toHaveText(ordinary)
    await expect(publicField).not.toContainText('staffing discussion')
    await expect(page.getByText('Whispering privately to Emma', { exact: true })).toHaveCount(0)
  }
  await test.info().attach('live-whisper-storage', { body: JSON.stringify(liveWhisperStates), contentType: 'application/json' })
})

for (const kind of ['chat', 'room'] as const) {
  test(`draft ${kind} selection cancels old hydration and follows item history`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
    await bootDemo(page, '/demo.html?tutorial=false')
    await page.evaluate(() => (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation())
    const initial = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
    const target = kind === 'chat' ? 'olivia@fluux.chat' : 'design@conference.fluux.chat'
    await page.locator(`[data-nav="${kind === 'chat' ? 'messages' : 'rooms'}"]`).click()
    await page.getByRole('complementary').getByText(kind === 'chat' ? 'Emma Wilson' : 'Team Chat', { exact: true }).click()
    const initialComposer = kind === 'chat' ? page.getByPlaceholder('Message Emma Wilson', { exact: true }) : page.getByRole('combobox', { name: 'Message #Team Chat', exact: true })
    await expect(initialComposer).toBeVisible()
    const baseRoute = kind === 'chat' ? 'messages' : 'rooms'
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/${baseRoute}/${encodeURIComponent(initial)}`)
    const initialHistoryLength = await page.evaluate(() => history.length)
    await page.evaluate(({ kind, initial, target }) => {
      const demo = window as unknown as {
        __chatStore: typeof import('@fluux/sdk/stores').chatStore
        __roomStore: typeof import('@fluux/sdk/stores').roomStore
        releaseOldDraftHydration: () => Promise<void>
      }
      function holdRead<T>(state: { loadMessagesFromCache: (id: string, options?: { limit?: number }) => Promise<T[]> }) {
        const load = state.loadMessagesFromCache
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        // Delay the real cache read so the older activation must lose ownership, not merely finish first.
        state.loadMessagesFromCache = async (id, options) => {
          if (id === initial) await held
          return load(id, options)
        }
        return { release, restore: (current: typeof state) => { current.loadMessagesFromCache = load } }
      }
      if (kind === 'chat') {
        demo.__chatStore.getState().setDraft(target, 'Review the agenda together tomorrow.')
        const held = holdRead(demo.__chatStore.getState())
        const pending = demo.__chatStore.getState().activateConversation(initial)
        demo.releaseOldDraftHydration = async () => { held.release(); await pending; held.restore(demo.__chatStore.getState()) }
      } else {
        demo.__roomStore.getState().setDraft(target, 'Review the agenda together tomorrow.', { ordinary: true })
        const held = holdRead(demo.__roomStore.getState())
        const pending = demo.__roomStore.getState().activateRoom(initial)
        demo.releaseOldDraftHydration = async () => { held.release(); await pending; held.restore(demo.__roomStore.getState()) }
      }
    }, { kind, initial, target })
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    await expect(palette).toBeVisible()
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await palette.getByRole('button', { name: kind === 'chat' ? /Olivia Park olivia/ : /Design Review design/ }).click()
    const restored = kind === 'chat' ? page.getByPlaceholder('Message Olivia Park', { exact: true }) : page.getByRole('combobox', { name: 'Message #Design Review', exact: true })
    if (kind === 'chat') await expect(restored).toHaveValue('Review the agenda together tomorrow.')
    else await expect(restored).toHaveText('Review the agenda together tomorrow.')
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/${baseRoute}/${encodeURIComponent(target)}`)
    expect(await page.evaluate(() => history.length)).toBe(initialHistoryLength + 1)
    await page.evaluate(() => (window as unknown as { releaseOldDraftHydration: () => Promise<void> }).releaseOldDraftHydration())
    expect(await page.evaluate(kind => {
      const demo = window as unknown as {
        __chatStore: typeof import('@fluux/sdk/stores').chatStore
        __roomStore: typeof import('@fluux/sdk/stores').roomStore
      }
      return kind === 'chat' ? demo.__chatStore.getState().activeConversationId : demo.__roomStore.getState().activeRoomJid
    }, kind)).toBe(target)
    await expect(restored).toBeVisible()
    const length = await page.evaluate(() => history.length)
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette).toBeVisible()
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await palette.getByRole('button', { name: kind === 'chat' ? /Olivia Park olivia/ : /Design Review design/ }).click()
    expect(await page.evaluate(() => history.length)).toBe(length)
    await page.goBack()
    await expect(initialComposer).toBeVisible()
    await page.goForward()
    await expect(restored).toBeVisible()
  })
}


test('whisper identity kinds do not share text and cancellation restores public keyboard focus', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => {
    const demo = window as unknown as { __demoClient: DemoClient; __roomStore: typeof import('@fluux/sdk/stores').roomStore }
    demo.__demoClient.stopAnimation()
    const room = demo.__roomStore.getState().getRoom('team@conference.fluux.chat')!
    const emma = room.occupants.get('Emma')!
    const olivia = room.occupants.get('Olivia')!
    if (!emma || !olivia) throw new Error('The demo room must contain both whisper recipients')
    demo.__roomStore.getState().addOccupant(room.jid, { ...emma, occupantId: olivia.nick })
    demo.__roomStore.getState().addOccupant(room.jid, { ...olivia, occupantId: undefined })
  })
  await page.locator('[data-nav="rooms"]').click()
  await page.getByRole('complementary').getByText('Team Chat', { exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Message #Team Chat', exact: true })).toBeVisible()
  const first = await enterWhisper(page)
  await first.fill('Only Emma should see this draft.')
  await page.evaluate(() => {
    const demo = window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }
    const room = demo.__roomStore.getState().getRoom('team@conference.fluux.chat')!
    const emma = room.occupants.get('Emma')!
    demo.__roomStore.getState().removeOccupant(room.jid, 'Emma')
    demo.__roomStore.getState().addOccupant(room.jid, { ...emma, nick: 'Emma-renamed' })
  })
  const renamed = await enterWhisper(page, 'Emma-renamed')
  await expect(renamed).toHaveText('Only Emma should see this draft.')
  const textAfterRename = await renamed.textContent()
  const second = await enterWhisper(page, 'Olivia')
  await expect(second).toHaveText('')
  const textForOtherRecipient = await second.textContent()
  await second.fill('Only Olivia should see this draft.')
  await second.press('Escape')
  const publicField = page.getByRole('combobox', { name: 'Message #Team Chat', exact: true })
  await expect(publicField).toBeFocused()
  await page.keyboard.type('Public agenda for everyone.')
  await expect(publicField).toHaveText('Public agenda for everyone.')
  await expect(publicField).not.toContainText('Only Olivia')
  await expect(publicField).not.toContainText('Only Emma')
  await test.info().attach('private-recipient-and-focus', {
    body: JSON.stringify({ textAfterRename, textForOtherRecipient, publicText: await publicField.textContent(), publicFocused: await publicField.evaluate(el => document.activeElement === el) }),
    contentType: 'application/json',
  })
})

test('older room text stays saved but only a public edit qualifies it for Drafts after reload', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => {
    const demo = window as unknown as { __demoClient: DemoClient; __roomStore: typeof import('@fluux/sdk/stores').roomStore }
    demo.__demoClient.stopAnimation()
    const rooms = demo.__roomStore.getState().joinedRooms()
    localStorage.setItem('fluux-room-drafts', JSON.stringify([['team@conference.fluux.chat', 'Older text whose recipient was not recorded.']]))
    demo.__roomStore.getState().switchAccount(null)
    for (const room of rooms) demo.__roomStore.getState().addRoom(room)
  })
  await page.locator('[data-nav="rooms"]').click()
  await page.getByRole('complementary').getByText('Team Chat', { exact: true }).click()
  const publicField = page.getByRole('combobox', { name: 'Message #Team Chat', exact: true })
  await expect(publicField).toHaveText('Older text whose recipient was not recorded.')
  const retainedLegacyText = await publicField.textContent()
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog')
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
  const legacyFinderEntryCount = await palette.getByRole('button', { name: /^Drafts/ }).count()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await page.getByRole('complementary').getByText('Design Review', { exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Message #Design Review', exact: true })).toBeVisible()
  await page.getByRole('complementary').getByText('Team Chat', { exact: true }).click()
  await expect(publicField).toHaveText('Older text whose recipient was not recorded.')
  expect(await page.evaluate(() => {
    const demo = window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }
    return demo.__roomStore.getState().ordinaryDrafts.has('team@conference.fluux.chat')
  })).toBe(false)
  await publicField.focus()
  await page.keyboard.press('End')
  await page.locator('[class~="[grid-area:emoji]"] > button').click()
  await page.locator('em-emoji-picker').getByRole('button', { name: '😀', exact: true }).first().click()
  await expect(publicField).toContainText('😀')
  await expect(publicField).toContainText('Older text whose recipient was not recorded.')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }).__roomStore.getState().ordinaryDrafts.has('team@conference.fluux.chat'))).toBe(true)
  await page.clock.install()
  await publicField.fill('A new public agenda for the whole room.')
  await page.clock.runFor(DRAFT_SAVE_DELAY_MS + 1)
  await page.clock.resume()
  await expect.poll(() => page.evaluate(() => {
    const demo = window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }
    return demo.__roomStore.getState().ordinaryDrafts.has('team@conference.fluux.chat')
  })).toBe(true)
  // Flush through the real account-loading boundary before recreating the app context.
  await page.evaluate(() => {
    const demo = window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }
    const rooms = demo.__roomStore.getState().joinedRooms()
    demo.__roomStore.getState().switchAccount(null)
    for (const room of rooms) demo.__roomStore.getState().addRoom(room)
  })
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation())
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toBeVisible()
  await palette.getByRole('button', { name: /^Drafts/ }).click()
  await palette.getByRole('button', { name: /Team Chat team/ }).click()
  await expect(publicField).toHaveText('A new public agenda for the whole room.')
  await test.info().attach('legacy-room-upgrade', {
    body: JSON.stringify({ retainedLegacyText, legacyFinderEntryCount, restoredText: await publicField.textContent(), qualifiedAfterReload: await page.evaluate(() => (window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }).__roomStore.getState().ordinaryDrafts.has('team@conference.fluux.chat')) }),
    contentType: 'application/json',
  })
})

for (const kind of ['chat', 'room'] as const) {
  test(`Back before draft ${kind} hydration completes keeps the source and loads the destination only once`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
    await bootDemo(page, '/demo.html?tutorial=false')
    const initial = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
    const target = kind === 'chat' ? 'olivia@fluux.chat' : 'design@conference.fluux.chat'
    await page.evaluate(() => (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation())
    await page.locator(`[data-nav="${kind === 'chat' ? 'messages' : 'rooms'}"]`).click()
    await page.getByRole('complementary').getByText(kind === 'chat' ? 'Emma Wilson' : 'Team Chat', { exact: true }).click()
    const source = kind === 'chat' ? page.getByPlaceholder('Message Emma Wilson', { exact: true }) : page.getByRole('combobox', { name: 'Message #Team Chat', exact: true })
    await expect(source).toBeVisible()
    const tab = kind === 'chat' ? 'messages' : 'rooms'
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/${tab}/${encodeURIComponent(initial)}`)
    await page.evaluate(({ kind, target }) => {
      const demo = window as unknown as {
        __chatStore: typeof import('@fluux/sdk/stores').chatStore
        __roomStore: typeof import('@fluux/sdk/stores').roomStore
        draftReadCalls: number
        releaseDestinationRead: () => Promise<void>
      }
      demo.draftReadCalls = 0
      function hold<T>(state: { loadMessagesFromCache: (id: string, options?: { limit?: number }) => Promise<T[]> }) {
        const load = state.loadMessagesFromCache
        let release!: () => void
        let finish!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        const finished = new Promise<void>(resolve => { finish = resolve })
        state.loadMessagesFromCache = async (id, options) => {
          if (id === target) { demo.draftReadCalls++; await held }
          const rows = await load(id, options)
          if (id === target) finish()
          return rows
        }
        return { release: async () => { release(); await finished }, restore: (current: typeof state) => { current.loadMessagesFromCache = load } }
      }
      if (kind === 'chat') {
        demo.__chatStore.getState().setDraft(target, 'Read this agenda later.')
        const held = hold(demo.__chatStore.getState())
        demo.releaseDestinationRead = async () => { await held.release(); held.restore(demo.__chatStore.getState()) }
      } else {
        demo.__roomStore.getState().setDraft(target, 'Read this agenda later.', { ordinary: true })
        const held = hold(demo.__roomStore.getState())
        demo.releaseDestinationRead = async () => { await held.release(); held.restore(demo.__roomStore.getState()) }
      }
    }, { kind, target })
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    await expect(palette).toBeVisible()
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await palette.getByRole('button', { name: kind === 'chat' ? /Olivia Park olivia/ : /Design Review design/ }).click()
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/${tab}/${encodeURIComponent(target)}`)
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette).toBeVisible()
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await palette.getByRole('button', { name: kind === 'chat' ? /Olivia Park olivia/ : /Design Review design/ }).click()
    expect(await page.evaluate(() => (window as unknown as { draftReadCalls: number }).draftReadCalls)).toBe(1)
    await page.goBack()
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/${tab}/${encodeURIComponent(initial)}`)
    await expect(source).toBeVisible()
    await page.evaluate(() => (window as unknown as { releaseDestinationRead: () => Promise<void> }).releaseDestinationRead())
    expect(await page.evaluate(() => (window as unknown as { draftReadCalls: number }).draftReadCalls)).toBe(1)
    expect(await page.evaluate(kind => {
      const demo = window as unknown as { __chatStore: typeof import('@fluux/sdk/stores').chatStore; __roomStore: typeof import('@fluux/sdk/stores').roomStore }
      return kind === 'chat' ? demo.__chatStore.getState().activeConversationId : demo.__roomStore.getState().activeRoomJid
    }, kind)).toBe(initial)
    await expect(source).toBeVisible()
    await test.info().attach('pending-back-result', {
      body: JSON.stringify(await page.evaluate(() => ({ route: location.hash, reads: (window as unknown as { draftReadCalls: number }).draftReadCalls }))),
      contentType: 'application/json',
    })
  })
}

for (const sourceTab of ['messages', 'rooms', 'contacts'] as const) {
  test(`switcher departure remembers the exact ${sourceTab} item for sidebar return`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
    await bootDemo(page, '/demo.html?tutorial=false')
    await page.evaluate(sourceTab => {
      const demo = window as unknown as { __demoClient: DemoClient; __chatStore: typeof import('@fluux/sdk/stores').chatStore; __roomStore: typeof import('@fluux/sdk/stores').roomStore }
      demo.__demoClient.stopAnimation()
      if (sourceTab === 'messages') demo.__roomStore.getState().setDraft('design@conference.fluux.chat', 'Public design agenda.', { ordinary: true })
      else demo.__chatStore.getState().setDraft('olivia@fluux.chat', 'A chat to finish later.')
    }, sourceTab)
    await page.locator(`[data-nav="${sourceTab}"]`).click()
    await page.getByRole('complementary').getByText(sourceTab === 'rooms' ? 'Design Review' : 'Emma Wilson', { exact: true }).click()
    const source = sourceTab === 'messages' ? page.getByPlaceholder('Message Emma Wilson', { exact: true })
      : sourceTab === 'rooms' ? page.getByRole('combobox', { name: 'Message #Design Review', exact: true })
      : page.getByRole('main').getByRole('heading', { name: 'Emma Wilson', exact: true })
    await expect(source).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    await expect(palette).toBeVisible()
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await palette.getByRole('button', { name: sourceTab === 'messages' ? /Design Review design/ : /Olivia Park olivia/ }).click()
    if (sourceTab === 'messages') await expect(page.getByRole('combobox', { name: 'Message #Design Review', exact: true })).toBeVisible()
    else await expect(page.getByPlaceholder('Message Olivia Park', { exact: true })).toBeVisible()
    await page.locator(`[data-nav="${sourceTab}"]`).click()
    await expect(source).toBeVisible()
    await test.info().attach('sidebar-return-result', { body: JSON.stringify({ sourceTab, route: await page.evaluate(() => location.hash) }), contentType: 'application/json' })
  })
}

for (const ordinary of [false, true]) {
  test(`${ordinary ? 'qualified public' : 'unclassified older'} room text keeps its qualification after failed-send recovery into a remounted editor`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
    await bootDemo(page, '/demo.html?tutorial=false')
    await page.evaluate(({ ordinary }) => {
      const demo = window as unknown as { __demoClient: DemoClient; __roomStore: typeof import('@fluux/sdk/stores').roomStore; rejectDraftSend: () => void }
      demo.__demoClient.stopAnimation()
      demo.__roomStore.getState().setDraft('team@conference.fluux.chat', 'Notes for the next review.', { ordinary })
      const messages = demo.__demoClient.messages
      const send = messages.sendMessage.bind(messages)
      let reject!: (reason: Error) => void
      const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise })
      messages.sendMessage = async (...args) => {
        if (args[0] !== 'team@conference.fluux.chat') return send(...args)
        await pending
        throw new Error('The isolated send was rejected')
      }
      demo.rejectDraftSend = () => {
        messages.sendMessage = send
        reject(new Error('The isolated send was rejected'))
      }
    }, { ordinary })
    await page.locator('[data-nav="rooms"]').click()
    await page.getByRole('complementary').getByText('Team Chat', { exact: true }).click()
    const field = page.getByRole('combobox', { name: 'Message #Team Chat', exact: true })
    await expect(field).toHaveText('Notes for the next review.')
    await field.press('Enter')
    await expect(field).toHaveText('')
    await page.getByRole('complementary').getByText('Design Review', { exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Message #Design Review', exact: true })).toBeVisible()
    await page.getByRole('complementary').getByText('Team Chat', { exact: true }).click()
    await expect(field).toHaveText('')
    await page.evaluate(() => (window as unknown as { rejectDraftSend: () => void }).rejectDraftSend())
    await expect(field).toHaveText('Notes for the next review.')
    const recovered = await page.evaluate(() => {
      const state = (window as unknown as { __roomStore: typeof import('@fluux/sdk/stores').roomStore }).__roomStore.getState()
      return { text: state.getDraft('team@conference.fluux.chat'), ordinary: state.ordinaryDrafts.has('team@conference.fluux.chat') }
    })
    expect(recovered).toEqual({ text: 'Notes for the next review.', ordinary })
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    await expect(palette).toBeVisible()
    if (ordinary) {
      await palette.getByRole('button', { name: /^Drafts/ }).click()
      await expect(palette.getByRole('button', { name: /Team Chat team/ })).toBeVisible()
    } else await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
    await test.info().attach('recovered-room-provenance', { body: JSON.stringify(recovered), contentType: 'application/json' })
  })
}
