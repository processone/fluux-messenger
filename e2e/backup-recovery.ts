/** Intent FLM-343: guided startup and Settings recovery are one confirmation
 * chain. This browser journey uses real backup crypto and mocked native IPC;
 * the separate native host runs the same App against actual Rust commands. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { syncEngineGeometry } from './harness/compositorSync'
import type { Locator, Page } from '@playwright/test'
import { bootDemo, reloadDemo } from './harness/demoBoot'

const meta = JSON.parse(readFileSync(new URL('../apps/fluux/src/e2ee/fixtures/sequoia_meta.json', import.meta.url), 'utf8')) as {
  aliceFingerprint: string; backupPassphrase: string; plaintext: string
}

test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })

const expectedBuild = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const fingerprint = meta.aliceFingerprint
const code = meta.backupPassphrase
const audit = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__recoveryFixture)
const keychainRetry = JSON.parse(readFileSync(new URL('../apps/fluux/src/i18n/locales/en.json', import.meta.url), 'utf8')).settings.encryption.keychainRetry as Record<string, string>
const keychainRetryTitle = keychainRetry.title
const retryReads = async (page: Page) => (await audit(page)).commands.filter((cmd: string) => cmd === 'openpgp_retry_keychain_access').length
const encryptionCopy = JSON.parse(readFileSync(new URL('../apps/fluux/src/i18n/locales/en.json', import.meta.url), 'utf8')).settings.encryption

/** FLM-408 R3: the plugin re-registration and the reconnect a session brings,
 * run without pressing the retry. Neither may read the refused items. The
 * App's own registration hook registers the new plugin and runs its follow-up. */
async function reregisterAndReconnect(page: Page) {
  const unlocks = async () => (await audit(page)).commands.filter((cmd: string) => cmd === 'openpgp_ensure_key').length
  const [reads, before] = [await retryReads(page), await unlocks()]
  const locked = await page.evaluate(async () => {
    const w = window as any, previous = w.__demoClient.e2ee.getPlugin('openpgp')
    await w.__recoveryTransitions.reregister()
    const next = w.__demoClient.e2ee.getPlugin('openpgp')
    await w.__recoveryTransitions.reconnect()
    return next !== previous && next.isKeyRecoveryNeeded() && !next.getOwnFingerprint()
  })
  expect(locked, 'a new plugin registered and its key stayed locked').toBe(true)
  expect(await unlocks(), 'the new plugin ran its normal unlock').toBeGreaterThan(before)
  expect(await retryReads(page), 'neither transition read the refused items').toBe(reads)
}

/** FLM-408 R1: press the retry while macOS's prompt stays open; every other
 * recovery action waits until the prompt is answered with a refusal. */
async function pressWithPromptOpen(page: Page, ask: Locator, held: Locator[], picture?: string) {
  await page.evaluate(() => (window as any).__recoveryPrompt.hold())
  await ask.click()
  await expect(page.getByRole('button', { name: keychainRetry.busy, exact: true })).toBeDisabled()
  if (picture) await capture(page, picture)
  for (const control of held) await expect(control).toBeDisabled()
  await page.evaluate(() => (window as any).__recoveryPrompt.answer())
  await expect(page.getByRole('alert')).toHaveText(keychainRetry.refusedAgain)
  for (const control of held) await expect(control).toBeEnabled()
}

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
    // FLM-304: no keychain refusal is held for a desynced key here, so no retry is offered.
    await expect(page.getByRole('button', { name: keychainRetryTitle, exact: true })).toBeHidden()
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

// Intent FLM-304, the captain's words on FLM-298: "Never, but maybe an explicit
// retry try could be proposed in a advanced panel, in case there is no other way
// to recover the key". The fixture's native side refuses the first retried read
// and grants the second; the App, panel and plugin run as shipped.
test('the advanced keychain retry asks macOS only on request and unlocks the same key', async ({ page }) => {
  await bootDemo(page, '/demo.html?tutorial=false&e2ee=recovery&recoveryBackup=absent')
  expect(await audit(page)).toMatchObject({ build: expectedBuild })
  await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.evaluate(() => { location.hash = '/settings/encryption' })
  await expect(page.getByText('The local key could not be unlocked.', { exact: false })).toBeVisible()
  const advanced = page.getByRole('button', { name: keychainRetryTitle, exact: true })
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: 'Restore from backup', exact: true })).toBeEnabled()
  await capture(page, 'after-settings-keychain-retry-folded.png')
  await advanced.click()
  const ask = page.getByRole('button', { name: keychainRetry.action, exact: true })
  await expect(ask).toBeVisible()
  expect(await retryReads(page), 'Showing or opening the panel must not read the keychain').toBe(0)
  await capture(page, 'after-settings-keychain-retry-open.png')
  // The App offers the guided restore again for the new plugin; the user
  // declines it, and the retry is folded again. Opening it reads nothing.
  const reregisterInSettings = async () => {
    await reregisterAndReconnect(page)
    await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(advanced).toHaveAttribute('aria-expanded', 'false')
    await advanced.click()
  }
  await reregisterInSettings()

  const restore = page.getByRole('button', { name: 'Restore from backup', exact: true })
  await pressWithPromptOpen(page, ask, [restore], 'after-settings-keychain-retry-busy.png')
  await expect(page.getByText('The local key could not be unlocked.', { exact: false })).toBeVisible()
  await expect(ask).toBeEnabled()
  expect(await retryReads(page)).toBe(1)
  await capture(page, 'after-keychain-refused-again.png')

  await reregisterInSettings()
  await ask.click()
  await expect(page.getByText('Your key is ready and published.', { exact: true })).toBeVisible()
  await expect(page.getByText(keychainRetry.success, { exact: true })).toBeVisible()
  await expect(advanced).toBeHidden()
  await capture(page, 'after-keychain-unlocked-ready.png')
  const unlocked = await audit(page)
  expect(await retryReads(page)).toBe(2)
  for (const effect of ['openpgp_backup_import_all', 'openpgp_backup_import_selected', 'openpgp_forget_account', 'openpgp_rotate_encryption_subkey']) {
    expect(unlocked.commands).not.toContain(effect)
  }
  expect(unlocked.publications).toContain('urn:xmpp:openpgp:0:public-keys')
  expect(unlocked.publications).not.toContain('urn:xmpp:openpgp:0:secret-key')
  expect(await page.evaluate(() => (window as any).__demoClient.e2ee.getPlugin('openpgp').getOwnFingerprint())).toBe(fingerprint)

  await page.evaluate(() => { location.hash = '/messages/' + encodeURIComponent('ava@fluux.chat') })
  await expect(page.getByText(meta.plaintext, { exact: true }).last()).toBeVisible()
  await capture(page, 'after-keychain-decrypted-message.png')

  await reloadDemo(page)
  await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeHidden()
  await page.evaluate(() => { location.hash = '/settings/encryption' })
  await expect(page.getByText('Your key is ready and published.', { exact: true })).toBeVisible()
  expect(await retryReads(page)).toBe(0)
})

// Intent FLM-304: the retry asks the macOS keychain again, so it is offered on
// desktop macOS only, even when another OS reports the same refusal and no backup.
test('the keychain retry stays hidden on desktop Windows', async ({ page }) => {
  await bootDemo(page, '/demo.html?tutorial=false&e2ee=recovery&recoveryBackup=absent&recoveryOs=windows')
  expect(await audit(page)).toMatchObject({ build: expectedBuild })
  const encryption = JSON.parse(readFileSync(new URL('../apps/fluux/src/i18n/locales/en.json', import.meta.url), 'utf8')).settings.encryption
  // Off macOS the refusal opens the identity choice; its server probe found no backup.
  const noBackup = page.getByRole('button', { name: encryption.identityChoice.restoreFromServerUnavailable, exact: false })
  await expect(noBackup).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.evaluate(() => { location.hash = '/settings/encryption' })
  await expect(page.getByText(encryption.statusRecoveryNeeded, { exact: true })).toBeVisible()
  await expect(noBackup).toBeDisabled()
  await expect(page.getByRole('button', { name: keychainRetryTitle, exact: true })).toBeHidden()
  await capture(page, 'keychain-retry-hidden-windows.png')
  // On macOS this view's panel asks the native probe when it mounts. Leaving
  // Settings renders again, and React first runs every pending mount effect.
  await page.evaluate(() => { location.hash = '/messages' })
  await expect(page.getByText(encryption.statusRecoveryNeeded, { exact: true })).toBeHidden()
  expect((await audit(page)).commands).not.toContain('openpgp_keychain_retry_available')
  expect(await retryReads(page)).toBe(0)
})

// Intent FLM-304: "in case there is no other way to recover the key". A desynced
// key whose old keychain item macOS refused opens the identity choice instead of
// Settings' restore entry, so the folded retry sits inside that choice, at
// startup and in Settings. The fixture refuses the first retried read.
for (const entry of ['startup', 'Settings']) {
  test(`a desynced key with a refused keychain item offers the retry inside the identity choice in ${entry}`, async ({ page }) => {
    await bootDemo(page, '/demo.html?tutorial=false&e2ee=recovery&recoveryFailure=desync-refused&recoveryBackup=absent')
    expect(await audit(page)).toMatchObject({ build: expectedBuild })
    const choice = JSON.parse(readFileSync(new URL('../apps/fluux/src/i18n/locales/en.json', import.meta.url), 'utf8')).settings.encryption.identityChoice
    const dialog = page.locator('[data-modal="true"]')
    const replace = dialog.getByRole('button', { name: new RegExp(choice.replaceTitle) })
    await expect(replace).toBeEnabled()
    await expect(dialog.getByRole('button', { name: new RegExp(choice.restoreFromServerTitle) })).toBeDisabled()
    if (entry === 'Settings') {
      // The startup Cancel only closes the choice; Settings opens it again.
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(replace).toBeHidden()
      await page.evaluate(() => { location.hash = '/settings/encryption' })
      await expect(replace).toBeEnabled()
    }
    const advanced = dialog.getByRole('button', { name: keychainRetryTitle, exact: true })
    await expect(advanced).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: keychainRetryTitle, exact: true })).toHaveCount(1)
    if (entry === 'startup') await capture(page, 'after-desync-keychain-retry-folded.png')
    await advanced.click()
    const ask = dialog.getByRole('button', { name: keychainRetry.action, exact: true })
    await expect(ask).toBeVisible()
    await expect(dialog.getByText(keychainRetry.backupHint.replace('{{action}}', choice.importFromFileTitle), { exact: true })).toBeVisible()
    expect(await retryReads(page), 'Showing or opening the retry must not read the keychain').toBe(0)
    if (entry === 'startup') await capture(page, 'after-desync-keychain-retry-open.png')
    // At startup, the App's follow-up for a new plugin replaces the choice's
    // plugin and folds the retry again; opening it reads nothing.
    const reregisterAtStartup = async () => {
      if (entry !== 'startup') return
      await reregisterAndReconnect(page)
      await expect(advanced).toHaveAttribute('aria-expanded', 'false')
      await advanced.click()
    }
    await reregisterAtStartup()

    const held = [
      replace,
      dialog.getByRole('button', { name: new RegExp(choice.importFromFileTitle) }),
      dialog.getByRole('button', { name: 'Cancel', exact: true }),
    ]
    await pressWithPromptOpen(page, ask, held, entry === 'startup' ? 'after-desync-keychain-retry-busy.png' : undefined)
    await expect(ask).toBeEnabled()
    expect(await retryReads(page)).toBe(1)
    if (entry === 'startup') await capture(page, 'after-desync-keychain-refused-again.png')

    await reregisterAtStartup()
    await ask.click()
    await expect(replace).toBeHidden()
    await expect(page.getByText(keychainRetry.success, { exact: true })).toBeVisible()
    expect(await retryReads(page)).toBe(2)
    expect(await page.evaluate(() => (window as any).__demoClient.e2ee.getPlugin('openpgp').getOwnFingerprint())).toBe(fingerprint)
    const unlocked = await audit(page)
    for (const effect of ['openpgp_backup_import_all', 'openpgp_backup_import_selected', 'openpgp_forget_account', 'openpgp_rotate_encryption_subkey']) {
      expect(unlocked.commands).not.toContain(effect)
    }
    expect(unlocked.publications).toContain('urn:xmpp:openpgp:0:public-keys')
    expect(unlocked.publications).not.toContain('urn:xmpp:openpgp:0:secret-key')
    if (entry === 'Settings') {
      // Closing the choice by unlocking leaves encryption on, unlike its Cancel.
      await expect(page.getByText('Your key is ready and published.', { exact: true })).toBeVisible()
      await expect(page.getByRole('switch', { name: 'OpenPGP end-to-end encryption', exact: true })).toHaveAttribute('aria-checked', 'true')
      await capture(page, 'after-desync-keychain-unlocked-settings.png')
    } else {
      await page.evaluate(() => { location.hash = '/messages/' + encodeURIComponent('ava@fluux.chat') })
      await expect(page.getByText(meta.plaintext, { exact: true }).last()).toBeVisible()
      await capture(page, 'after-desync-keychain-decrypted-message.png')
    }
  })
}

// Intent FLM-408 R2: macOS allows the second prompt, but the secret it reads
// still cannot unlock the key. That consumes the refusal, so both placements
// keep the failure and its details and stop offering another retry.
for (const placement of ['Settings', 'identity choice']) {
  test(`a granted read that cannot unlock the key leaves no retry to press in the ${placement}`, async ({ page }) => {
    const desync = placement === 'identity choice'
    await bootDemo(page, `/demo.html?tutorial=false&e2ee=recovery&recoveryBackup=absent&recoveryRetry=unlock-fails${desync ? '&recoveryFailure=desync-refused' : ''}`)
    expect(await audit(page)).toMatchObject({ build: expectedBuild })
    const scope = desync ? page.locator('[data-modal="true"]') : page.locator('body')
    if (!desync) {
      await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.evaluate(() => { location.hash = '/settings/encryption' })
    }
    const advanced = scope.getByRole('button', { name: keychainRetryTitle, exact: true })
    await advanced.click()
    const ask = scope.getByRole('button', { name: keychainRetry.action, exact: true })
    await ask.click()
    await expect(scope.getByRole('alert')).toHaveText(keychainRetry.refusedAgain)
    await ask.click()
    await expect(scope.getByRole('alert')).toHaveText(keychainRetry.failed)
    await scope.getByText(encryptionCopy.recoveryErrorDetails, { exact: true }).click()
    await expect(scope.getByText(/decrypt persisted TSK/)).toBeVisible()
    await expect(ask).toBeVisible()
    await capture(page, `after-${desync ? 'desync-' : ''}keychain-unlock-failed.png`)
    await expect(ask).toBeDisabled()
    await expect(advanced).toHaveAttribute('aria-expanded', 'true')
    expect(await retryReads(page)).toBe(2)
    expect(await page.evaluate(() => (window as any).__demoClient.e2ee.getPlugin('openpgp').keychainRetryState())).toBe('none')
    if (desync) await expect(scope.getByRole('button', { name: new RegExp(encryptionCopy.identityChoice.importFromFileTitle) })).toBeEnabled()
    else await expect(page.getByRole('button', { name: 'Restore from backup', exact: true })).toBeEnabled()
  })
}

// Intent FLM-408 R4: a press that outlives its time limit while macOS's
// prompt stays open has not spent the refusal. Both placements keep the
// failure and an enabled button; once the user refuses that prompt, the next
// press asks macOS again.
for (const placement of ['Settings', 'identity choice']) {
  test(`a retry that times out on an open prompt stays available in the ${placement}`, async ({ page }) => {
    const desync = placement === 'identity choice'
    await bootDemo(page, `/demo.html?tutorial=false&e2ee=recovery&recoveryBackup=absent${desync ? '&recoveryFailure=desync-refused' : ''}`)
    expect(await audit(page)).toMatchObject({ build: expectedBuild })
    const scope = desync ? page.locator('[data-modal="true"]') : page.locator('body')
    if (!desync) {
      await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.evaluate(() => { location.hash = '/settings/encryption' })
    }
    const advanced = scope.getByRole('button', { name: keychainRetryTitle, exact: true })
    await advanced.click()
    const ask = scope.getByRole('button', { name: keychainRetry.action, exact: true })
    // The page's clock decides when the native call's two-minute limit expires.
    await page.clock.install()
    await page.evaluate(() => (window as any).__recoveryPrompt.hold())
    await ask.click()
    await expect(scope.getByRole('button', { name: keychainRetry.busy, exact: true })).toBeDisabled()
    await page.clock.fastForward(121_000)
    await expect(scope.getByRole('alert')).toHaveText(keychainRetry.failed)
    await scope.getByText(encryptionCopy.recoveryErrorDetails, { exact: true }).click()
    await expect(scope.getByText(/openpgp_retry_keychain_access timeout after 120000 ms/)).toBeVisible()
    await expect(ask).toBeVisible()
    await capture(page, `after-${desync ? 'desync-' : ''}keychain-retry-timed-out.png`)
    await expect(ask).toBeEnabled()
    expect(await page.evaluate(() => (window as any).__demoClient.e2ee.getPlugin('openpgp').keychainRetryState())).toBe('unconfirmed')
    // The user refuses the prompt the timed-out press opened.
    await page.evaluate(() => (window as any).__recoveryPrompt.answer())
    await expect.poll(() => page.evaluate(() => (window as any).__demoClient.e2ee.getPlugin('openpgp').keychainRetryState())).toBe('offered')
    await expect(ask).toBeEnabled()
    expect(await retryReads(page)).toBe(1)
    await ask.click()
    await expect(page.getByText(keychainRetry.success, { exact: true })).toBeVisible()
    if (desync) await expect(scope).toBeHidden()
    else await expect(page.getByText('Your key is ready and published.', { exact: true })).toBeVisible()
    expect(await retryReads(page)).toBe(2)
    expect(await page.evaluate(() => (window as any).__demoClient.e2ee.getPlugin('openpgp').getOwnFingerprint())).toBe(fingerprint)
  })
}

// Intent FLM-408 R5: macOS allows a prompt only after its press timed out,
// so the key is unlocked natively while the App still has it locked.
// Reopening Settings or the identity choice keeps an action to use that key,
// and pressing it asks macOS nothing.
for (const placement of ['Settings', 'identity choice']) {
  test(`a key macOS allowed after a timed-out retry stays ready to use in the ${placement}`, async ({ page }) => {
    const desync = placement === 'identity choice'
    await bootDemo(page, `/demo.html?tutorial=false&e2ee=recovery&recoveryBackup=absent${desync ? '&recoveryFailure=desync-refused' : ''}`)
    expect(await audit(page)).toMatchObject({ build: expectedBuild })
    const scope = desync ? page.locator('[data-modal="true"]') : page.locator('body')
    if (!desync) {
      await expect(page.getByRole('heading', { name: 'Restore from backup', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.evaluate(() => { location.hash = '/settings/encryption' })
    }
    const advanced = scope.getByRole('button', { name: keychainRetryTitle, exact: true })
    await advanced.click()
    const ask = scope.getByRole('button', { name: keychainRetry.action, exact: true })
    await ask.click()
    await expect(scope.getByRole('alert')).toHaveText(keychainRetry.refusedAgain)
    // The next press outlives its two-minute limit on an open prompt.
    await page.clock.install()
    await page.evaluate(() => (window as any).__recoveryPrompt.hold())
    await ask.click()
    await expect(scope.getByRole('button', { name: keychainRetry.busy, exact: true })).toBeDisabled()
    await page.clock.fastForward(121_000)
    await expect(scope.getByRole('alert')).toHaveText(keychainRetry.failed)
    // The user then allows that prompt; the fixture's native side unlocks the key.
    await page.evaluate(() => (window as any).__recoveryPrompt.answer())
    await expect.poll(() => page.evaluate(() => localStorage.getItem('__test_recovery_bundle') !== null)).toBe(true)
    const plugin = () => page.evaluate(() => {
      const p = (window as any).__demoClient.e2ee.getPlugin('openpgp')
      return { locked: p.isKeyRecoveryNeeded() as boolean, fingerprint: p.getOwnFingerprint() as string | null }
    })
    expect(await plugin()).toEqual({ locked: true, fingerprint: null })
    const presses = await retryReads(page)
    const probes = async () => (await audit(page)).commands.filter((cmd: string) => cmd === 'openpgp_keychain_retry_available').length
    const probed = await probes()
    // Leave and reopen the panel's place: Settings, or the identity choice Settings opens.
    if (desync) {
      await scope.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(scope).toBeHidden()
    }
    await page.evaluate(() => { location.hash = '/messages' })
    await page.evaluate(() => { location.hash = '/settings/encryption' })
    if (desync) await expect(scope.getByRole('button', { name: new RegExp(encryptionCopy.identityChoice.importFromFileTitle) })).toBeEnabled()
    else await expect(page.getByRole('button', { name: 'Restore from backup', exact: true })).toBeEnabled()
    await expect.poll(probes, 'the reopened panel asked again whether a retry applies').toBeGreaterThan(probed)
    await expect(advanced).toHaveAttribute('aria-expanded', 'false')
    await capture(page, `after-${desync ? 'desync-' : ''}keychain-retry-ready-reopened.png`)
    await advanced.click()
    await expect(scope.getByText(keychainRetry.readyBody, { exact: true })).toBeVisible()
    const use = scope.getByRole('button', { name: keychainRetry.readyAction, exact: true })
    await expect(use).toBeEnabled()
    await expect(ask).toBeHidden()
    await capture(page, `after-${desync ? 'desync-' : ''}keychain-retry-ready.png`)
    await use.click()
    await expect(page.getByText(keychainRetry.success, { exact: true })).toBeVisible()
    if (desync) await expect(scope).toBeHidden()
    else await expect(page.getByText('Your key is ready and published.', { exact: true })).toBeVisible()
    expect(await plugin()).toEqual({ locked: false, fingerprint })
    // One more request, answered with the key already unlocked: the fixture
    // asks macOS nothing for it, and nothing restores or replaces a key.
    expect(await retryReads(page)).toBe(presses + 1)
    const unlocked = await audit(page)
    for (const effect of ['openpgp_backup_import_all', 'openpgp_backup_import_selected', 'openpgp_forget_account', 'openpgp_rotate_encryption_subkey']) {
      expect(unlocked.commands).not.toContain(effect)
    }
    expect(unlocked.publications).toContain('urn:xmpp:openpgp:0:public-keys')
  })
}

for (const backup of ['present', 'unknown']) {
  test(`the keychain retry stays hidden when a ${backup} server backup may recover the key`, async ({ page }) => {
    await bootDemo(page, '/demo.html?tutorial=false&e2ee=recovery')
    expect(await audit(page)).toMatchObject({ build: expectedBuild })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(backup => {
      const w = window as any, plugin = w.__demoClient.e2ee.getPlugin('openpgp')
      if (backup === 'unknown') plugin.fetchSecretKeyBackup = async () => { throw new Error('remote-server-timeout') }
      // Record the plugin's answer so the hidden panel is a settled decision, not a pending one.
      const state = plugin.keychainRetryState.bind(plugin)
      w.__retryOffers = []
      plugin.keychainRetryState = async () => { const answer = await state(); w.__retryOffers.push(answer); return answer }
    }, backup)
    await page.evaluate(() => { location.hash = '/settings/encryption' })
    await expect(page.getByText('The local key could not be unlocked.', { exact: false })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restore from backup', exact: true })).toBeEnabled()
    await expect.poll(() => page.evaluate(() => (window as any).__retryOffers.length)).toBeGreaterThan(0)
    const offers: string[] = await page.evaluate(() => (window as any).__retryOffers)
    expect(offers).not.toContain('offered')
    expect(offers).not.toContain('ready')
    expect((await audit(page)).commands).toContain('openpgp_keychain_retry_available')
    await expect(page.getByRole('button', { name: keychainRetryTitle, exact: true })).toBeHidden()
    expect(await retryReads(page)).toBe(0)
    await capture(page, `keychain-retry-hidden-${backup}-backup.png`)
  })
}
