import { useEffect, type RefObject } from 'react'

/**
 * Interface for any element that can be focused.
 * Works with HTMLInputElement, HTMLTextAreaElement, or custom components
 * that expose a focus() method (like MessageComposerHandle).
 */
interface Focusable {
  focus: () => void
}

/**
 * Hook that automatically focuses an input element when the user starts typing
 * outside input fields and modals in the window.
 *
 * This provides a Slack/Discord-like experience where you can just start typing
 * to compose a message or search without clicking the input first.
 *
 * @param focusableRef - Ref to any focusable element (input, textarea, or custom component with focus())
 * @param enabled - Whether the hook is active (default: true)
 */
export function useTypeToFocus(
  focusableRef: RefObject<Focusable | null>,
  enabled: boolean = true
) {
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-modal="true"]')) return
      // Skip if target is already an input field
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      // Skip if modifier keys are pressed (except Shift for capital letters)
      // This prevents interfering with keyboard shortcuts like Ctrl+C, Cmd+N, Alt+1
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return
      }

      // Skip function keys (F1-F12)
      if (e.key.startsWith('F') && e.key.length > 1 && !isNaN(parseInt(e.key.slice(1)))) {
        return
      }

      // Skip non-printable keys (arrows, escape, tab, etc.)
      // Printable characters have key.length === 1
      // Exception: allow Backspace and Delete in case user wants to delete
      const isPrintable = e.key.length === 1
      const isBackspaceOrDelete = e.key === 'Backspace' || e.key === 'Delete'

      if (!isPrintable && !isBackspaceOrDelete) {
        return
      }

      // Skip if ref is not available
      const focusable = focusableRef.current
      if (!focusable) {
        return
      }

      // Focus the element
      focusable.focus()

      // For printable characters, append to existing text
      // The browser will handle the keypress after focus, so we don't need to manually insert
      // But we do need to prevent default to avoid double-insertion in some cases
      // Actually, let's NOT prevent default - after focusing, the input will receive the keystroke naturally

      // For Backspace/Delete, just focus - the input will handle the key
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [focusableRef, enabled])
}
