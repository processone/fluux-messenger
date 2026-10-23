/**
 * What MessageComposer needs from its input element. A textarea has all of it;
 * the room composer's contenteditable editor exposes the same members on its
 * root element (see RoomComposerEditor), so the composer never has to know
 * which one it was given.
 */
export type ComposerInputElement = HTMLElement & {
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  setSelectionRange(start: number, end: number): void
}

/** A change reported by the input: the new text and caret are read off `target`. */
export interface ComposerChangeEvent {
  target: ComposerInputElement
}

/** A caret or selection move reported by the input. */
export interface ComposerSelectEvent {
  currentTarget: ComposerInputElement
}
