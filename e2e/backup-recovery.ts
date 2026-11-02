/** Intent FLM-343: guided startup and Settings recovery are one confirmation
 * chain. This browser journey uses real backup crypto and mocked native IPC;
 * the separate native host runs the same App against actual Rust commands. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { syncEngineGeometry } from './harness/compositorSync'
import type { Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

const meta = JSON.parse(readFileSync(new URL('../apps/fluux/src/e2ee/fixtures/sequoia_meta.json', import.meta.url), 'utf8')) as {
  aliceFingerprint: string; backupPassphrase: string; plaintext: string
}

test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })

const expectedBuild = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const fingerprint = meta.aliceFingerprint
const code = meta.backupPassphrase
const audit = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__recoveryFixture)

async function openRecovery(page: Page) {
  await bootDemo(page, '/demo.html?tutorial=false&e2ee=recovery')
  expect(await audit(page), 'The recovery fixture must come from this working copy’s current build').toMatchObject({ build: expectedBuild })
  await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeVisible()
}
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready)
  await syncEngineGeometry(page)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath(name) })
}
function backupInput(page: Page) {
  return page.locator('input[name="backup-code"], input[name="passphrase"]')
}
async function serverCode(page: Page, value = code) {
  await page.getByRole('button', { name: 'Restore from server backup', exact: true }).click()
  await backupInput(page).fill(value)
}
async function previewServer(page: Page) {
  await serverCode(page)
  await page.getByRole('button', { name: 'Preview backup', exact: true }).click()
  await expect(page.getByText(fingerprint, { exact: true })).toBeVisible()
}

for (const source of ['server', 'file']) {
  test(`guided ${source} restore previews, confirms and refreshes Settings without replacing its backup`, async ({ page }) => {
    await openRecovery(page)
    if (source === 'server') {
      await capture(page, 'after-startup-recovery.png')
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.evaluate(() => { location.hash = '/settings/encryption' })
      await expect(page.getByText('The local key could not be unlocked.', { exact: false })).toBeVisible()
      await capture(page, 'after-settings-recovery-needed.png')
      await page.getByRole('button', { name: 'Restore from backup', exact: true }).click()
    }
    await page.getByRole('button', { name: source === 'server' ? 'Restore from server backup' : 'Import from a file', exact: true }).click()
    const input = backupInput(page)
    await input.fill(code)
    await capture(page, `after-${source}-code.png`)
    await page.getByRole('button', { name: 'Preview backup', exact: true }).click()
    await expect(page.getByText(fingerprint, { exact: true })).toBeVisible()
    expect((await audit(page)).commands.filter((cmd: string) => cmd === 'openpgp_backup_import_selected')).toHaveLength(0)
    await capture(page, `after-${source}-confirmation.png`)
    await page.getByRole('button', { name: 'Use this key', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Confirm restored key', exact: true })).toBeHidden()
    await page.evaluate(() => { location.hash = '/messages/' + encodeURIComponent('ava@fluux.chat') })
    await expect(page.getByText(meta.plaintext, { exact: true }).last()).toBeVisible()
    await capture(page, `after-${source}-decrypted-message.png`)
    expect((await audit(page)).commands.filter((cmd: string) => cmd === 'openpgp_backup_import_selected')).toHaveLength(1)
    expect((await audit(page)).publications).not.toContain('urn:xmpp:openpgp:0:secret-key')
    expect((await audit(page)).commands).not.toContain('openpgp_forget_account')
    expect((await audit(page)).commands).not.toContain('openpgp_rotate_encryption_subkey')
    await page.evaluate(() => { location.hash = '/settings/encryption' })
    await expect(page.getByText('Your key is ready and published.', { exact: true })).toBeVisible()
    await capture(page, `after-${source}-ready.png`)
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

// The service failures below are native/protocol readings injected at their
// boundary. The actual App, dialog, plugin and install guards still execute.
test('wrong code and cancellation leave the identity untouched and recovery usable', async ({ page }) => {
  await openRecovery(page)
  await page.evaluate(() => { (window as any).__demoClient.e2ee.getPlugin('openpgp').pickKeyFile = async () => null })
  await page.getByRole('button', { name: 'Import from a file', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore from server backup', exact: true })).toBeEnabled()
  await serverCode(page, (code[0] === 'A' ? 'B' : 'A') + code.slice(1))
  await page.getByRole('button', { name: 'Preview backup', exact: true }).click()
  await expect(page.getByText(/Session key decryption failed/i)).toBeVisible()
  expect((await audit(page)).commands).not.toContain('openpgp_backup_import_selected')
  await capture(page, 'wrong-code.png')
  await backupInput(page).fill(code)
  await page.getByRole('button', { name: 'Preview backup', exact: true }).click()
  await expect(page.getByText(fingerprint, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Confirm restored key' })).toBeHidden()
  expect((await audit(page)).commands).not.toContain('openpgp_backup_import_selected')
})

for (const state of ['absent', 'unknown']) {
  test(`a ${state} backup probe never becomes a native install`, async ({ page }) => {
    await openRecovery(page)
    await page.evaluate(state => {
      const plugin = (window as any).__demoClient.e2ee.getPlugin('openpgp')
      plugin.fetchSecretKeyBackup = state === 'absent' ? async () => null : async () => { throw new Error('remote-server-timeout') }
    }, state)
    await serverCode(page)
    await page.getByRole('button', { name: 'Preview backup', exact: true }).click()
    await expect(page.getByText(state === 'absent' ? /no secret-key backup found/i : /remote-server-timeout/i)).toBeVisible()
    expect((await audit(page)).commands).not.toContain('openpgp_backup_import_all')
    expect((await audit(page)).commands).not.toContain('openpgp_backup_import_selected')
    await capture(page, `backup-${state}.png`)
  })
}

async function injectUncertainSave(page: Page) {
  await page.evaluate(() => {
    const w = window as any, plugin = w.__demoClient.e2ee.getPlugin('openpgp')
    const invoke = plugin.invoke.bind(plugin)
    w.__nativeAttempts = 0
    plugin.invoke = (cmd: string, args: unknown) => {
      if (cmd === 'openpgp_backup_import_selected') {
        w.__nativeAttempts++
        return Promise.reject(new Error('openpgp-restore-outcome-uncertain: the restored key is in use but its record is not confirmed durable. The previous key is kept.'))
      }
      return invoke(cmd, args)
    }
  })
}

test('an uncertain native save preserves its details and cannot be submitted again from Settings', async ({ page }) => {
  await openRecovery(page)
  await injectUncertainSave(page)
  await previewServer(page)
  await page.getByRole('button', { name: 'Use this key', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText(/Restart the app to check the saved identity/)
  await expect(page.getByRole('button', { name: 'Use this key', exact: true })).toBeDisabled()
  await page.getByText('Technical details', { exact: true }).click()
  await expect(page.getByText(/not confirmed durable/)).toBeVisible()
  await capture(page, 'uncertain-native-save.png')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.evaluate(() => { location.hash = '/settings/encryption' })
  await page.getByRole('button', { name: 'Restore from backup', exact: true }).click()
  await previewServer(page)
  await expect(page.getByRole('button', { name: 'Use this key', exact: true })).toBeDisabled()
  await expect(page.getByRole('alert')).toHaveText(/Restart the app to check the saved identity/)
  expect(await page.evaluate(() => (window as any).__nativeAttempts)).toBe(1)
  expect((await audit(page)).publications).not.toContain('urn:xmpp:openpgp:0:secret-key')
  // A WebView reload is not an application restart or a known native outcome.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeVisible()
  await previewServer(page)
  await expect(page.getByRole('button', { name: 'Use this key', exact: true })).toBeDisabled()
  await expect(page.getByRole('alert')).toHaveText(/Restart the app to check the saved identity/)
  expect((await audit(page)).commands).not.toContain('openpgp_backup_import_selected')
})

for (const phase of ['server-fetch', 'file-picker', 'confirmed-save']) {
  test(`logout during ${phase} cannot revive the old plugin or install into another account`, async ({ page }) => {
    await openRecovery(page)
    await page.evaluate(async phase => {
      const w = window as any, plugin = w.__demoClient.e2ee.getPlugin('openpgp')
      w.__oldRecoveryPlugin = plugin
      w.__operationFinished = false
      if (phase === 'file-picker') {
        const content = await plugin.pickKeyFile()
        plugin.pickKeyFile = () => new Promise(resolve => { w.__releaseRecovery = () => { resolve(content); w.__operationFinished = true } })
      } else if (phase === 'server-fetch') {
        const content = await plugin.fetchSecretKeyBackup()
        plugin.fetchSecretKeyBackup = () => new Promise(resolve => { w.__releaseRecovery = () => resolve(content) })
        const restore = plugin.restoreSecretKey.bind(plugin)
        plugin.restoreSecretKey = async (...args: unknown[]) => { try { return await restore(...args) } finally { w.__operationFinished = true } }
      } else {
        const invoke = plugin.invoke.bind(plugin), install = plugin.installSelectedKey.bind(plugin)
        plugin.invoke = (cmd: string, args: any) => cmd === 'openpgp_backup_import_selected'
          ? new Promise((resolve, reject) => { w.__releaseRecovery = () => { w.__oldInstallAccount = args.accountJid; return invoke(cmd, args).then(resolve, reject) } })
          : invoke(cmd, args)
        plugin.installSelectedKey = async (...args: unknown[]) => { try { return await install(...args) } finally { w.__operationFinished = true } }
      }
    }, phase)
    if (phase === 'file-picker') await page.getByRole('button', { name: 'Import from a file', exact: true }).click()
    else {
      await serverCode(page)
      await page.getByRole('button', { name: 'Preview backup', exact: true }).click()
      if (phase === 'confirmed-save') {
        await expect(page.getByText(fingerprint, { exact: true })).toBeVisible()
        await page.getByRole('button', { name: 'Use this key', exact: true }).click()
      }
    }
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseRecovery)).toBe('function')
    await page.evaluate(async () => {
      const w = window as any
      w.__demoClient.e2ee = null
      // The real macOS logout normally destroys this realm to repair WRY input.
      // Keep the scripted browser realm alive so the late reply is observable.
      sessionStorage.removeItem('__wry_was_online')
      w.__connectionStore.getState().setStatus('disconnected')
      await w.__oldRecoveryPlugin.shutdown()
      await w.__releaseRecovery()
    })
    await expect.poll(() => page.evaluate(() => (window as any).__operationFinished)).toBe(true)
    expect(await page.evaluate(() => (window as any).__oldRecoveryPlugin.getOwnFingerprint())).toBeNull()
    await expect(page.getByRole('heading', { name: 'Confirm restored key' })).toBeHidden()
    await expect(page.getByText('Key restored from server', { exact: true })).toBeHidden()
    if (phase === 'confirmed-save') expect(await page.evaluate(() => (window as any).__oldInstallAccount)).toBe('you@fluux.chat')
    else expect((await audit(page)).commands).not.toContain('openpgp_backup_import_selected')
  })
}

test('a real multi-key backup requires the intended fingerprint before installation', async ({ page }) => {
  const { decrypt, readMessage, encrypt, createMessage } = await import('openpgp')
  const { parseSecretKeysFromBackupPayload } = await import('../apps/fluux/src/e2ee/backupKeyMaterial')
  const { legacyNormalizeBackupPassphrase } = await import('../apps/fluux/src/e2ee/backupPassphrase')
  const keys = []
  for (const [name, passphrase] of [['sequoia_alice_backup.asc', code], ['web_bob_backup.asc', legacyNormalizeBackupPassphrase(code)]]) {
    const armoredMessage = readFileSync(new URL(`../apps/fluux/src/e2ee/fixtures/${name}`, import.meta.url), 'utf8')
    const result = await decrypt({ message: await readMessage({ armoredMessage }), passwords: [passphrase], format: 'binary' })
    keys.push(...await parseSecretKeysFromBackupPayload(result.data))
  }
  const bytes = new Uint8Array(keys.flatMap(key => [...key.write()]))
  const backup = await encrypt({ message: await createMessage({ binary: bytes }), passwords: [code], format: 'armored' })
  await openRecovery(page)
  await page.evaluate(backup => { (window as any).__demoClient.e2ee.getPlugin('openpgp').fetchSecretKeyBackup = async () => backup }, backup)
  await previewServer(page)
  await expect(page.getByRole('radio')).toHaveCount(keys.length)
  const otherFingerprint = keys.map(key => key.getFingerprint().toUpperCase()).find(value => value !== fingerprint)!
  await page.getByRole('radio', { name: new RegExp(otherFingerprint) }).check()
  await expect(page.getByRole('radio', { name: new RegExp(fingerprint) })).not.toBeChecked()
  await page.getByRole('radio', { name: new RegExp(fingerprint) }).check()
  expect((await audit(page)).commands).not.toContain('openpgp_backup_import_selected')
  await capture(page, 'multi-key-confirmation.png')
  await page.getByRole('button', { name: 'Use this key', exact: true }).click()
  await page.evaluate(() => { location.hash = '/messages/' + encodeURIComponent('ava@fluux.chat') })
  await expect(page.getByText(meta.plaintext, { exact: true }).last()).toBeVisible()
  expect((await audit(page)).commands.filter((cmd: string) => cmd === 'openpgp_backup_import_selected')).toHaveLength(1)
})

// FLM-365 F1: corruption/desync is not protected-storage refusal. Replacement
// remains a deliberate available decision, never executed by this test.
for (const backup of ['present', 'absent']) {
  test(`macOS desync with ${backup} backup retains identity choice at startup, Settings and toggle`, async ({ page }) => {
    await bootDemo(page, `/demo.html?tutorial=false&e2ee=recovery&recoveryFailure=desync&recoveryBackup=${backup}`)
    expect(await audit(page)).toMatchObject({ build: expectedBuild })
    const unknown = JSON.parse(readFileSync(new URL('../apps/fluux/src/i18n/locales/en.json', import.meta.url), 'utf8')).settings.encryption.identityChoice.restoreFromServerUnknown
    const expectDecision = async () => {
      await expect(page.getByRole('button', { name: /Replace the published identity/ })).toBeEnabled()
      const server = page.getByRole('button', { name: /Restore from server backup/ })
      if (backup === 'present') await expect(server).toBeEnabled()
      else await expect(server).toBeDisabled()
      // A failed probe must not masquerade as the present fixture.
      await expect(page.getByText(unknown, { exact: true })).toBeHidden()
    }
    await expectDecision()
    await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeHidden()
    await capture(page, `desync-${backup}-startup.png`)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(() => { location.hash = '/settings/encryption' })
    await expectDecision()
    await capture(page, `desync-${backup}-settings.png`)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    const toggle = page.getByRole('switch', { name: 'OpenPGP end-to-end encryption', exact: true })
    // Main's Cancel intentionally disables encryption; re-enable from that state.
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expectDecision()
    await capture(page, `desync-${backup}-toggle.png`)
    expect((await audit(page)).commands).not.toContain('openpgp_forget_account')
    expect((await audit(page)).commands).not.toContain('openpgp_backup_import_selected')
    expect(await page.evaluate(() => (window as any).__demoClient.e2ee.getPlugin('openpgp').getOwnFingerprint())).toBeNull()
    expect((await audit(page)).publications).toEqual([])
  })
}

// FLM-365 F4: translated guidance is primary; native diagnostic details stay available.
test('French recovery displays restart guidance immediately in French after an uncertain save', async ({ page }) => {
  const fr = JSON.parse(readFileSync(new URL('../apps/fluux/src/i18n/locales/fr.json', import.meta.url), 'utf8')).settings.encryption
  await openRecovery(page)
  await injectUncertainSave(page)
  await previewServer(page)
  await page.evaluate(() => (window as any).__i18n.changeLanguage('fr'))
  await page.getByRole('button', { name: fr.keyPicker.confirm, exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText(fr.recoveryRestartRequired)
  await capture(page, 'french-uncertain-save.png')
  await page.getByText(fr.recoveryErrorDetails, { exact: true }).click()
  await expect(page.getByText(/not confirmed durable/)).toBeVisible()
  await capture(page, 'french-uncertain-save-details.png')
})
