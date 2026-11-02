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
    if (!window.__FLUUX_RECOVERY_RESTART__) {
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
    await window.__TAURI_INTERNALS__.invoke('recovery_checkpoint', { fingerprint: fp })
  }
  const failure = error => {
    const state = { ready: document.readyState, headings: [...document.querySelectorAll('h1,h2,h3')].map(el => el.textContent),
      buttons: [...document.querySelectorAll('[data-modal] button')].filter(el => el.offsetWidth).map(el => ({ text: el.textContent.trim(), disabled: el.disabled })),
      inputLength: document.querySelector('input[name="backup-code"], input[name="passphrase"]')?.value.length,
      audit: window.__recoveryFixture }
    return window.__TAURI_INTERNALS__.invoke('recovery_failure', { reason: error.message + '; ' + JSON.stringify(state) })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start().catch(failure), { once: true })
  else start().catch(failure)
})()
