/**
 * History discipline for selecting an item (conversation, room, contact)
 * within a view.
 *
 * We want a standard browser-like back stack: selecting a *different* item
 * pushes a new history entry so Back retraces the visited items, while
 * re-selecting the item that is already active must not stack a duplicate
 * entry (consecutive dedup). Programmatic navigation (auto-select on connect,
 * session restore) is handled separately with an explicit `replace`.
 *
 * @param target  the item the user is navigating to
 * @param current the currently-active item (null when none is selected yet)
 * @returns true to replace the current history entry, false to push a new one
 */
export function shouldReplaceOnSelect(
  target: string | null | undefined,
  current: string | null | undefined,
): boolean {
  return target != null && target === current
}
