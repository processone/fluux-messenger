/**
 * Workaround for Tauri's macOS webview inserting control characters when
 * arrow keys are pressed at text boundaries.
 * See: https://github.com/tauri-apps/tauri/issues/10194
 *
 * Two layers of defence:
 * 1. A global `beforeinput` listener (installed by `installBeforeInputGuard`)
 *    that **prevents** control chars from ever being inserted — no flicker.
 * 2. The `TextInput` / `TextArea` wrappers in ui/TextInput.tsx use
 *    `CONTROL_CHAR_RE` in their `onChange` handler as a reactive safety net.
 */

// Keep newlines (\n = 0x0A) and tabs (\t = 0x09); filter other C0 control chars and DEL.
// eslint-disable-next-line no-control-regex
export const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

// Same pattern but without the global flag — for a quick `.test()` check.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_TEST = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/**
 * Install a global `beforeinput` listener that blocks control-character
 * insertions before they reach any `<input>`, `<textarea>`, or
 * contentEditable element.  Call once at app startup (e.g. in main.tsx).
 */
export function installBeforeInputGuard(): void {
  document.addEventListener(
    'beforeinput',
    (e: InputEvent) => {
      if (
        e.inputType === 'insertText' &&
        e.data &&
        CONTROL_CHAR_TEST.test(e.data)
      ) {
        e.preventDefault()
      }
    },
    { capture: true },
  )
}
