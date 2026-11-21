/** Keep launch autofocus quiet and distinguish pointer input from keyboard input.
 * Chromium can retain :focus-visible when an already-focused button is clicked;
 * CSS uses this modality marker to hide that stale ring without moving focus.
 */
export function installFocusRings() {
  const mark = (modality: 'pointer' | 'keyboard') => {
    const root = document.documentElement
    root.classList.add('user-interacted')
    root.dataset.focusModality = modality
  }
  window.addEventListener('mousedown', () => mark('pointer'), true)
  // Observe before React/overlay handlers consume a key and stop propagation.
  window.addEventListener('keydown', () => mark('keyboard'), true)
}
