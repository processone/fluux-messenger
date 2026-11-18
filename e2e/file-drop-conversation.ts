// Intent: FLM-196 option A (issue #957) — a file dropped on a sidebar conversation opens it and
// stages the file in its composer, keeping that conversation's draft; nothing is uploaded or
// sent until the user presses Send.
import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'

const FIRST = 'emma@fluux.chat'
const TARGET = 'ava@fluux.chat'
const proof = (name: string) => process.env.FLUUX_DROP_PROOF ? `${process.env.FLUUX_DROP_PROOF}/${name}.png` : undefined

async function boot(page: Page) {
  const uploads: string[] = []
  page.on('request', (r) => { if (r.method() === 'PUT' || r.method() === 'POST') uploads.push(`${r.method()} ${r.url()}`) })
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => {
    const w = window as any
    w.__demoClient.stopAnimation()
    w.__demoClient.messages.sendChatState = async () => {}
    w.__sent = []
    w.__demoClient.messages.sendMessage = async (...args: unknown[]) => { w.__sent.push(args) }
    w.__connectionStore.getState().setHttpUploadService({ jid: 'upload.fluux.chat', maxFileSize: 10_000_000 })
  })
  await activateChat(page, FIRST)
  return uploads
}

async function dropOnRow(page: Page, jid: string, name = 'notes.txt') {
  const dataTransfer = await page.evaluateHandle((n) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['private notes'], n, { type: 'text/plain' }))
    return dt
  }, name)
  const row = page.locator(`[data-conv-id="${jid}"]`)
  await row.dispatchEvent('dragenter', { dataTransfer })
  await row.dispatchEvent('dragover', { dataTransfer })
  await row.dispatchEvent('drop', { dataTransfer })
}

const active = (page: Page) => page.evaluate(() => (window as any).__chatStore.getState().activeConversationId)

test('a file dropped on another conversation opens it and stages the file without sending', async ({ page }) => {
  const uploads = await boot(page)

  await dropOnRow(page, TARGET)

  await expect.poll(() => active(page)).toBe(TARGET)
  await expect(page.getByText('notes.txt').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove attachment' })).toBeVisible()
  const shot = proof('staged-on-target')
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' })
  expect(await page.evaluate(() => (window as any).__sent.length)).toBe(0)
  expect(uploads).toEqual([])
})

test('the target keeps its draft, and leaving drops the file but not the draft', async ({ page }) => {
  const uploads = await boot(page)
  await activateChat(page, TARGET)
  const field = page.getByPlaceholder(/^Message /).first()
  await field.fill('draft for Ava')
  await activateChat(page, FIRST)

  await dropOnRow(page, TARGET)

  await expect.poll(() => active(page)).toBe(TARGET)
  await expect(page.getByRole('button', { name: 'Remove attachment' })).toBeVisible()
  await expect(page.getByPlaceholder(/^Message /).first()).toHaveValue('draft for Ava')
  const shot = proof('draft-kept-with-file')
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' })
  expect(await page.evaluate(() => (window as any).__sent.length)).toBe(0)
  expect(uploads).toEqual([])

  await activateChat(page, FIRST)
  await activateChat(page, TARGET)
  await expect(page.getByRole('button', { name: 'Remove attachment' })).toHaveCount(0)
  await expect(page.getByPlaceholder(/^Message /).first()).toHaveValue('draft for Ava')
})

test('a drop on the already open conversation stages the file there', async ({ page }) => {
  const uploads = await boot(page)

  await dropOnRow(page, FIRST)

  await expect(page.getByRole('button', { name: 'Remove attachment' })).toBeVisible()
  expect(await active(page)).toBe(FIRST)
  expect(uploads).toEqual([])
})
