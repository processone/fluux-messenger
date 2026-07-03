/**
 * Native context-menu suppression for the desktop app.
 *
 * On packaged Tauri builds we hide the raw WebView menu (Reload, Inspect
 * Element, Save Image As...) everywhere except where the native menu is
 * genuinely useful: editable fields and active text selections. Web / PWA
 * builds are never affected, and `tauri:dev` keeps the menu so right-click
 * Inspect Element still works while developing.
 */

/** True when an active, non-empty selection intersects the target element. */
function isTargetWithinSelection(target: Element, selection: Selection | null): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
  if (selection.toString().trim() === '') return false
  return selection.getRangeAt(0).intersectsNode(target)
}

/**
 * Decide whether the native context menu should be suppressed for a
 * `contextmenu` event.
 *
 * Returns `false` (allow the native menu) when:
 * - the event was already handled by a component (`defaultPrevented`),
 * - the target is inside an `<input>`, `<textarea>`, or contenteditable region,
 * - the target falls within an active text selection.
 * Otherwise returns `true` (suppress).
 */
export function shouldSuppressNativeMenu(
  target: EventTarget | null,
  selection: Selection | null,
  defaultPrevented: boolean,
): boolean {
  if (defaultPrevented) return false
  if (!(target instanceof Element)) return true

  // Editable regions keep the native menu (cut / copy / paste / spellcheck).
  if (target.closest('input, textarea')) return false
  if (target instanceof HTMLElement && target.isContentEditable) return false

  // An active selection under the cursor keeps the native menu (copy).
  if (isTargetWithinSelection(target, selection)) return false

  return true
}
