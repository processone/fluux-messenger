// Measurement only: no focus, selection, editor-content or paint changes during sampling.
import { appConfigDir } from '@tauri-apps/api/path'
import { readTextFile, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const editor = () => document.querySelector('.message-input')
const rect = element => {
  if (!element) return null
  const { x, y, width: w, height: h } = element.getBoundingClientRect()
  return { x, y, w, h }
}
const describe = element => element ? { tag: element.tagName, cls: element.className } : null
function state() {
  const input = editor()
  const selection = getSelection()
  const point = node => node ? { tag: node.nodeName, inEditor: !!input?.contains(node) } : null
  const style = input && getComputedStyle(input)
  return {
    at: performance.now(), hash: location.hash, focused: document.hasFocus(),
    editorFocus: document.activeElement === input, active: describe(document.activeElement),
    ring: !!input?.closest('.composer-card')?.matches(':focus-within'),
    value: input ? (input.value ?? input.textContent) : null,
    label: input?.getAttribute('aria-label'), caret: style?.caretColor,
    fontSize: parseFloat(style?.fontSize), lineHeight: parseFloat(style?.lineHeight),
    selection: [point(selection.anchorNode), selection.anchorOffset, point(selection.focusNode), selection.focusOffset],
    textareaSelection: input?.tagName === 'TEXTAREA' ? [input.selectionStart, input.selectionEnd] : null,
    rect: rect(input), card: rect(input?.closest('.composer-card')), pad: parseFloat(style?.paddingLeft),
    view: [screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight, devicePixelRatio],
  }
}

let events = []
for (const type of ['pointerdown', 'mousedown', 'click', 'focusin', 'focusout', 'keydown', 'keyup', 'beforeinput', 'input']) {
  document.addEventListener(type, event => {
    events.push({ at: performance.now(), type, trusted: event.isTrusted, target: describe(event.target),
      clientX: event.clientX, clientY: event.clientY, key: event.key, data: event.data,
      inputType: event.inputType, detail: event.detail })
    if (events.length > 200) events.shift()
  }, true)
}
async function observe() {
  for (let i = 0; i < 600 && !(window.__fluuxDemoReady && window.__fluuxShellSettled); i++) await wait(150)
  if (!window.__fluuxDemoReady) throw Error('Demo did not seed')
  if (location.origin !== 'tauri://localhost') throw Error('Not the packaged demo')
  if ((await appConfigDir()).replace(/\/$/, '') !== __EXPECTED_APP_CONFIG__) throw Error('Not this isolated lab profile')
  window.__demoClient.stopAnimation()
  // Stores import before demo.tsx clears localStorage. Reset only these sample drafts,
  // before either measured composer is opened, so an earlier lab run cannot seed it.
  window.__roomStore.getState().setDraft('design@conference.fluux.chat', '')
  window.__chatStore.getState().setDraft('emma@fluux.chat', '')
  const readiness = { localOrigin: location.origin, demoReady: true, shellSettled: true }
  let handled = 0
  for (;;) {
    let command
    try {
      command = JSON.parse(await readTextFile('caret-probe/command.json', { baseDir: BaseDirectory.AppConfig }))
    } catch { await wait(65); continue }
    if (command.id <= handled) { await wait(65); continue }
    handled = command.id
    let response
    try {
      switch (command.op) {
        case 'state': break
        case 'arm': events = []; break
        // The no-caret reference is made only AFTER the observation interval.
        case 'hide-reference': editor().style.setProperty('caret-color', 'transparent', 'important'); await wait(75); break
        case 'show-reference': editor().style.removeProperty('caret-color'); break
        default: throw Error('Unknown observer command')
      }
      response = {
        state: state(), readiness, events: [...events],
        rows: [...document.querySelectorAll('.sidebar-row[data-room-jid],.sidebar-row[data-conv-id]')]
          .map(row => ({ id: row.getAttribute('data-room-jid') ?? row.getAttribute('data-conv-id'), box: rect(row) })),
        nav: Object.fromEntries([...document.querySelectorAll('[data-nav]')].map(node => [node.dataset.nav, rect(node)])),
      }
    } catch (error) { response = { error: String(error) } }
    await writeTextFile(`caret-probe/result-${handled}.json`, JSON.stringify(response), { baseDir: BaseDirectory.AppConfig })
  }
}
observe().catch(error => console.error('Caret lab observer:', error))
