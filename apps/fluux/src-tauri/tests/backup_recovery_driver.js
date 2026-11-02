// FLM-343: test-only driver of the real App, not a second recovery model.
// All waits observe rendered state; no retry, sleeps or sensitive input.
(() => {
  const wait = predicate => new Promise((resolve, reject) => {
    const observer = new MutationObserver(check)
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('native recovery journey timed out')) }, 90000)
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
    await wait(() => document.querySelector('[data-nav="messages"]'))
    if (!window.__FLUUX_RECOVERY_RESTART__) {
      ;(await wait(() => button(window.__FLUUX_RECOVERY_SOURCE__ === 'file' ? 'Import from a file' : 'Restore from server backup'))).click()
      const input = await wait(() => document.querySelector('input[type="password"]'))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, meta.backupPassphrase)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      ;(await wait(() => button('Preview backup'))).click()
      await wait(() => [...document.querySelectorAll('span')].some(el => el.textContent === fp))
      ;(await wait(() => button('Use this key'))).click()
    }
    await wait(() => window.__demoClient?.e2ee?.getPlugin('openpgp')?.getOwnFingerprint() === fp && !document.querySelector('[data-modal]'))
    await wait(() => window.__chatStore?.getState().messages.get('ava@fluux.chat')?.some(m => m.id === 'recovery-waiting' && m.body === meta.plaintext && !m.encryptedPayload) && document.body.textContent.includes(meta.plaintext))
    await window.__TAURI_INTERNALS__.invoke('recovery_checkpoint', { fingerprint: fp })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start().catch(error => window.__TAURI_INTERNALS__.invoke('recovery_failure', { reason: error.message })), { once: true })
  else start().catch(error => window.__TAURI_INTERNALS__.invoke('recovery_failure', { reason: error.message }))
})()
