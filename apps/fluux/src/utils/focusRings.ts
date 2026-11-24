const keydownModalities = new WeakMap<KeyboardEvent, string | undefined>()

/** Read the input mode before this key updated focus-ring styling. */
export function isKeyboardModalityAtKeydown(event: KeyboardEvent): boolean {
  return (keydownModalities.get(event) ?? document.documentElement.dataset.focusModality) !== 'pointer'
}

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
  const onMouseDown = () => mark('pointer')
  const onKeyDown = (event: KeyboardEvent) => {
    // Consumers need the original input mode even though rings update in capture.
    keydownModalities.set(event, document.documentElement.dataset.focusModality)
    mark('keyboard')
  }
  window.addEventListener('mousedown', onMouseDown, true)
  // Observe before React/overlay handlers consume a key and stop propagation.
  window.addEventListener('keydown', onKeyDown, true)
  return () => {
    window.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('keydown', onKeyDown, true)
  }
}
