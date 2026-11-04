// FLM-343: test-only driver of the real App, not a second recovery model.
// All waits observe rendered state; no retry, sleeps or sensitive input.
(() => {
  // The disposable native profile must use the same language as the driver.
  localStorage.setItem('i18nextLng', 'en')
  const wait = (predicate, label) => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check)
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('native recovery journey timed out: ' + label)) }, 90000)
    function check() {
      const result = predicate()
      if (result) { clearTimeout(timeout); observer.disconnect(); resolve(result) }
    }
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    check()
  })
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
  const start = async () => {
    const meta = window.__FLUUX_RECOVERY_META__
    const fp = meta.aliceFingerprint
    await wait(() => document.querySelector('[data-nav="messages"]'), 'app shell')
    if (!window.__recoveryFixture?.native || window.__recoveryFixture.build !== window.__FLUUX_RECOVERY_EXPECTED_BUILD__) {
      throw new Error('Native recovery proof requires this working copy’s current bundled app and actual Rust commands')
    }
    const note = label => window.__TAURI_INTERNALS__.invoke('recovery_note', { label })
    const account = { accountJid: 'you@fluux.chat' }
    // FLM-408 R4: the native answer is 'held', 'not-held' or 'pending'.
    const retryOffered = async () => (await window.__TAURI_INTERNALS__.invoke('openpgp_keychain_retry_available', account)) === 'held'
    const heading = text => [...document.querySelectorAll('h1,h2,h3')].some(el => el.textContent === text)
    const plugin = () => window.__demoClient.e2ee.getPlugin('openpgp')
    // FLM-304 and FLM-408 R3: what may happen around the retry without a
    // press, each step marked in the host's operations log so it counts that
    // step's reads: the prewarm a login starts, the normal unlock, the App's
    // own registration of a new plugin, a reconnect, then the panel shown
    // again (`panel`, given by the journey). None may read a refused item.
    const transitions = async (n, afterRegistration, panel) => {
      const unlock = { ...account, userId: 'xmpp:you@fluux.chat' }
      await note('prewarm-' + n)
      await window.__TAURI_INTERNALS__.invoke('openpgp_prewarm', unlock)
      await note('unlock-' + n)
      await window.__TAURI_INTERNALS__.invoke('openpgp_ensure_key', unlock)
        .then(() => { throw new Error('the key unlocked without a press') }, () => {})
      await note('reregister-' + n)
      const previous = plugin()
      await window.__recoveryTransitions.reregister()
      if (plugin() === previous || !plugin().isKeyRecoveryNeeded()) throw new Error('the App did not register a new plugin with the key locked')
      await afterRegistration()
      await note('reconnect-' + n)
      await window.__recoveryTransitions.reconnect()
      await note('panel-' + n)
      return panel()
    }
    if (!window.__FLUUX_RECOVERY_RESTART__ && window.__FLUUX_RECOVERY_SOURCE__ === 'retry') {
      // FLM-304: decline the startup restore, then retry the keychain from Settings.
      await wait(() => heading('Restore from backup'), 'startup restore offer')
      ;(await wait(() => button('Cancel'), 'startup restore cancel')).click()
      location.hash = '/settings/encryption'
      const ask = () => button('Ask macOS again')
      // The App offers the guided restore again for its new plugin; decline it.
      const declineRestore = async () => {
        ;(await wait(() => heading('Restore from backup') && button('Cancel'), 'restore offered for the new plugin')).click()
        await wait(() => !heading('Restore from backup'), 'restore declined again')
      }
      // Leave Settings and open its panel again.
      const reopen = async () => {
        location.hash = '/messages'
        await wait(() => !button('Advanced: ask the keychain again'), 'left Settings')
        location.hash = '/settings/encryption'
        ;(await wait(() => button('Advanced: ask the keychain again'), 'advanced keychain retry panel')).click()
        return wait(ask, 'keychain retry action')
      }
      ;(await wait(() => button('Advanced: ask the keychain again'), 'advanced keychain retry panel')).click()
      await transitions(1, declineRestore, reopen)
      await note('click-1')
      ask().click()
      await wait(() => [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent === 'macOS refused access again. The key is still locked.') && ask(), 'second refusal shown')
      await transitions(2, declineRestore, reopen)
      await window.__TAURI_INTERNALS__.invoke('recovery_grant_keychain')
      await note('click-2')
      ask().click()
      await wait(() => document.body.textContent.includes('Your key is ready and published.'), 'unlocked status')
      if (await retryOffered()) throw new Error('the keychain retry is still offered after the key unlocked')
      location.hash = '/messages/' + encodeURIComponent('ava@fluux.chat')
    } else if (!window.__FLUUX_RECOVERY_RESTART__ && window.__FLUUX_RECOVERY_SOURCE__ === 'retry-desync') {
      // FLM-304: the desynced key opens the identity choice at startup; its
      // folded retry asks macOS for the refused old item.
      const advanced = () => [...document.querySelectorAll('[data-modal] button')].find(b => b.textContent.trim() === 'Advanced: ask the keychain again' && !b.disabled)
      const ask = () => button('Ask macOS again')
      // The App's follow-up gives the choice the new plugin, whose retry starts folded.
      const folded = () => wait(() => advanced()?.getAttribute('aria-expanded') === 'false', 'retry folded for the new plugin')
      // Open the panel, fold it and open it again.
      const refold = async () => {
        advanced().click()
        await wait(() => advanced()?.getAttribute('aria-expanded') === 'true' && ask(), 'keychain retry opened')
        advanced().click()
        await wait(() => advanced()?.getAttribute('aria-expanded') === 'false', 'keychain retry folded')
        advanced().click()
        return wait(() => advanced()?.getAttribute('aria-expanded') === 'true' && ask(), 'keychain retry action')
      }
      ;(await wait(advanced, 'keychain retry in the startup identity choice')).click()
      await wait(ask, 'keychain retry action')
      await transitions(1, folded, refold)
      await note('click-1')
      ask().click()
      await wait(() => [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent === 'macOS refused access again. The key is still locked.') && ask(), 'second refusal shown')
      await transitions(2, folded, refold)
      await window.__TAURI_INTERNALS__.invoke('recovery_grant_keychain')
      await note('click-2')
      ask().click()
      await wait(() => !document.querySelector('[data-modal]'), 'identity choice closed by the unlock')
      if (await retryOffered()) throw new Error('the keychain retry is still offered after the key unlocked')
      location.hash = '/messages/' + encodeURIComponent('ava@fluux.chat')
    } else if (!window.__FLUUX_RECOVERY_RESTART__) {
      ;(await wait(() => button(window.__FLUUX_RECOVERY_SOURCE__ === 'file' ? 'Import from a file' : 'Restore from server backup'), 'backup source chooser')).click()
      const input = await wait(() => document.querySelector('input[name="backup-code"], input[name="passphrase"]'), 'backup code field')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, meta.backupPassphrase)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      ;(await wait(() => button('Preview backup'), 'enabled preview action')).click()
      await wait(() => [...document.querySelectorAll('span')].some(el => el.textContent === fp), 'fingerprint preview')
      ;(await wait(() => button('Use this key'), 'enabled key confirmation')).click()
    }
    await wait(() => window.__demoClient?.e2ee?.getPlugin('openpgp')?.getOwnFingerprint() === fp && !document.querySelector('[data-modal]'), 'restored identity and closed dialog')
    await wait(() => window.__chatStore?.getState().messages.get('ava@fluux.chat')?.some(m => m.id === 'recovery-waiting' && m.body === meta.plaintext && !m.encryptedPayload) && document.body.textContent.includes(meta.plaintext), 'decrypted waiting message')
    if (!window.__FLUUX_RECOVERY_SOURCE__.startsWith('retry')) {
      // FLM-304: a restored account is never offered the keychain retry, and a
      // direct request answers with the restored key; the host's operation log
      // rejects any old-item read after the restore.
      if (await retryOffered()) throw new Error('the keychain retry is offered for a restored account')
      const retried = await window.__TAURI_INTERNALS__.invoke('openpgp_retry_keychain_access', account)
      if (retried.fingerprint !== fp) throw new Error('the keychain retry answered another key for a restored account')
      location.hash = '/settings/encryption'
      await wait(() => document.body.textContent.includes('Your key is ready and published.'), 'restored key ready in Settings')
      if (button('Advanced: ask the keychain again')) throw new Error('the keychain retry panel is shown for a restored account')
      location.hash = '/messages/' + encodeURIComponent('ava@fluux.chat')
    }
    await window.__TAURI_INTERNALS__.invoke('recovery_checkpoint', { fingerprint: fp })
  }
  const failure = error => {
    const state = { ready: document.readyState, headings: [...document.querySelectorAll('h1,h2,h3')].map(el => el.textContent),
      buttons: [...document.querySelectorAll('[data-modal] button')].filter(el => el.offsetWidth).map(el => ({ text: el.textContent.trim(), disabled: el.disabled })),
      inputLength: document.querySelector('input[name="backup-code"], input[name="passphrase"]')?.value.length,
      audit: window.__recoveryFixture }
    // Native commands reject with a plain string, not an Error.
    return window.__TAURI_INTERNALS__.invoke('recovery_failure', { reason: (error?.message ?? String(error)) + '; ' + JSON.stringify(state) })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start().catch(failure), { once: true })
  else start().catch(failure)
})()
