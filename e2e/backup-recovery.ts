/** Intent FLM-343: guided startup and Settings recovery are one confirmation
 * chain. This browser journey uses real backup crypto and mocked native IPC;
 * the separate native host runs the same App against actual Rust commands. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { bootDemo } from './harness/demoBoot'

const meta = JSON.parse(readFileSync(new URL('../apps/fluux/src/e2ee/fixtures/sequoia_meta.json', import.meta.url), 'utf8')) as {
  aliceFingerprint: string; backupPassphrase: string; plaintext: string
}

test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })

const expectedBuild = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const fingerprint = meta.aliceFingerprint
const code = meta.backupPassphrase
const audit = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__recoveryFixture)

for (const source of ['server', 'file']) {
  test(`guided ${source} restore previews, confirms and refreshes Settings without replacing its backup`, async ({ page }) => {
    await bootDemo(page, '/demo.html?tutorial=false&e2ee=recovery')
    expect(await audit(page), 'The recovery fixture must come from this working copy’s current build').toMatchObject({ build: expectedBuild })
    await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeVisible()
    if (source === 'server') {
      await page.screenshot({ animations: 'disabled', path: test.info().outputPath('after-startup-recovery.png') })
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.evaluate(() => { location.hash = '/settings/encryption' })
      await expect(page.getByText('The local key could not be unlocked.', { exact: false })).toBeVisible()
      await page.screenshot({ animations: 'disabled', path: test.info().outputPath('after-settings-recovery-needed.png') })
      await page.getByRole('button', { name: 'Restore from backup', exact: true }).click()
    }
    await page.getByRole('button', { name: source === 'server' ? 'Restore from server backup' : 'Import from a file', exact: true }).click()
    const input = page.locator('input[type="password"]')
    await input.fill(code)
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`after-${source}-code.png`) })
    await page.getByRole('button', { name: 'Preview backup', exact: true }).click()
    await expect(page.getByText(fingerprint, { exact: true })).toBeVisible()
    expect((await audit(page)).commands.filter((cmd: string) => cmd === 'openpgp_backup_import_selected')).toHaveLength(0)
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`after-${source}-confirmation.png`) })
    await page.getByRole('button', { name: 'Use this key', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Confirm restored key', exact: true })).toBeHidden()
    await page.evaluate(() => { location.hash = '/messages/' + encodeURIComponent('ava@fluux.chat') })
    await expect(page.getByText(meta.plaintext, { exact: true }).last()).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`after-${source}-decrypted-message.png`) })
    expect((await audit(page)).commands.filter((cmd: string) => cmd === 'openpgp_backup_import_selected')).toHaveLength(1)
    expect((await audit(page)).publications).not.toContain('urn:xmpp:openpgp:0:secret-key')
    expect((await audit(page)).commands).not.toContain('openpgp_forget_account')
    expect((await audit(page)).commands).not.toContain('openpgp_rotate_encryption_subkey')
    await page.evaluate(() => { location.hash = '/settings/encryption' })
    await expect(page.getByText('Your key is ready and published.', { exact: true })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`after-${source}-ready.png`) })
    await page.reload()
    await expect(page.locator('[data-nav="messages"]')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeHidden()
    await page.evaluate(() => { location.hash = '/settings/encryption' })
    await expect(page.getByText('Your key is ready and published.', { exact: true })).toBeVisible()
    await page.evaluate(() => { location.hash = '/messages/' + encodeURIComponent('ava@fluux.chat') })
    await expect(page.getByText(meta.plaintext, { exact: true }).last()).toBeVisible()
    expect((await audit(page)).commands).not.toContain('openpgp_backup_import_selected')
  })
}
