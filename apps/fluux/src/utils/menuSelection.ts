/**
 * The words a pointer menu treats as selected. A right-click (or Control-click) makes some engines
 * select the word under the pointer, and that word is not a selection the person made: the text is
 * read as the button goes down, and only words that were already selected then count.
 */

/** Read as the button goes down: the current selection for a right-click, null for any other press. */
export function selectionAtButtonDown(event: { button: number; ctrlKey: boolean }): string | null {
  return event.button === 2 || event.ctrlKey ? (window.getSelection()?.toString() ?? '') : null
}

/**
 * The selection a menu opened inside `container` offers: `text` is empty when nothing was selected
 * before the click. A word that only the click selected is cleared so the menu opens over no selection.
 */
export function selectionForMenu(container: Element, before: string | null): { text: string; range?: Range } {
  const selection = window.getSelection()
  const text = selection && !selection.isCollapsed && selection.rangeCount > 0
    && selection.getRangeAt(0).intersectsNode(container) ? selection.toString() : ''
  const selected = text.trim() !== '' && (before === null || before === text) ? text : ''
  if (text && !selected) selection?.removeAllRanges()
  return selected ? { text: selected, range: selection!.getRangeAt(0).cloneRange() } : { text: '' }
}
