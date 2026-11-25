import { expect, test } from '@playwright/test'
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
      await page.screenshot({ path: `${process.env.FLUUX_DRAFT_PROOF}/after-entry-${width}.png`, animations: 'disabled' })
    }
    await input.press('Enter')
    await expect(input).toHaveAttribute('placeholder', 'Find a draft…')
    await expect(palette.getByRole('button', { name: /Emma Wilson emma/ })).toBeVisible()
    await expect(palette.getByRole('button', { name: /Design Review design/ })).toBeVisible()
    await expect(palette).not.toContainText('revised drawings')
    await expect(palette).not.toContainText('updated spacing')
    const observedNames = await palette.getByRole('button').allTextContents()
    if (process.env.FLUUX_DRAFT_PROOF) {
      await page.screenshot({ path: `${process.env.FLUUX_DRAFT_PROOF}/after-list-${width}.png`, animations: 'disabled' })
    }
    await input.fill('updated spacing')
    await expect(palette.getByText('No results found')).toBeVisible()
    await expect(palette.getByRole('button', { name: /Search messages/ })).toHaveCount(0)
    await palette.getByRole('button', { name: /Back/ }).focus()
    await page.keyboard.press('Enter')
    await expect(input).toHaveAttribute('placeholder', 'Go to...')
    await palette.getByRole('button', { name: /^Drafts/ }).click()
    await expect(input).toBeFocused()
    await input.fill('emma')
    await input.press('Enter')
    await expect(palette).toBeHidden()
    await expect(chatField).toHaveValue('I can bring the revised drawings on Thursday.')
    const restoredChat = await chatField.inputValue()
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
    await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await roomField.press('ArrowUp')
    await expect(page.getByText('Editing message', { exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await roomField.press('Escape')
    await expect(page.getByText('Editing message', { exact: true })).toHaveCount(0)
    await page.evaluate(() => {
      const demo = window as unknown as { __connectionStore: typeof import('@fluux/sdk/stores').connectionStore }
      demo.__connectionStore.getState().setHttpUploadService({ jid: 'upload.fluux.chat', maxFileSize: 10_000_000 })
    })
    await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/media/landscape-1280x720.jpg')
    await expect(page.getByRole('button', { name: 'Remove attachment', exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette.getByRole('button', { name: /^Drafts/ })).toHaveCount(0)
    const stagedFileDraftEntries = await palette.getByRole('button', { name: /^Drafts/ }).count()
    await page.keyboard.press('Escape')
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
