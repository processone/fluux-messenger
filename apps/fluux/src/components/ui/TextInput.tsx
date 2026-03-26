/**
 * Drop-in replacements for <input> and <textarea> that filter out control
 * characters Tauri's unstable feature incorrectly inserts when arrow keys
 * are pressed at text boundaries on macOS.
 * See: https://github.com/tauri-apps/tauri/issues/10194
 *
 * Primary protection is the global `beforeinput` guard installed in main.tsx.
 * This onChange filter is a reactive safety net in case anything slips through.
 */
import { forwardRef, useCallback, type ChangeEvent } from 'react'
import { CONTROL_CHAR_RE } from '@/utils/tauriInputFix'

function filterControlChars<T extends HTMLInputElement | HTMLTextAreaElement>(
  e: ChangeEvent<T>,
  originalOnChange?: (e: ChangeEvent<T>) => void,
) {
  const raw = e.target.value
  const clean = raw.replace(CONTROL_CHAR_RE, '')

  if (raw !== clean) {
    const cursorPos = e.target.selectionStart ?? 0
    const beforeCursor = raw.slice(0, cursorPos)
    const controlsBefore = (beforeCursor.match(CONTROL_CHAR_RE) || []).length
    const adjusted = Math.max(0, cursorPos - controlsBefore)

    // Patch the value in-place so the onChange handler sees the clean string
    const nativeSet = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(e.target),
      'value',
    )!.set!
    nativeSet.call(e.target, clean)

    originalOnChange?.(e)

    // Restore cursor after React re-render
    const el = e.target
    setTimeout(() => el.setSelectionRange(adjusted, adjusted), 0)
    return
  }

  originalOnChange?.(e)
}

/**
 * Drop-in replacement for `<input>` with Tauri control-character filtering.
 */
export const TextInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function TextInput({ onChange, ...props }, ref) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => filterControlChars(e, onChange),
    [onChange],
  )
  return <input ref={ref} {...props} onChange={handleChange} />
})

/**
 * Drop-in replacement for `<textarea>` with Tauri control-character filtering.
 */
export const TextArea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea({ onChange, ...props }, ref) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => filterControlChars(e, onChange),
    [onChange],
  )
  return <textarea ref={ref} {...props} onChange={handleChange} />
})
