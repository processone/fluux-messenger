/**
 * The room composer's input: one contenteditable that draws the text, the
 * `@mention` colour and the caret in a single layout.
 *
 * It replaces a transparent textarea stacked on a mirror div. Two layers can
 * disagree about where a line wraps, and anything the engine adds to only one of
 * them (macOS inline predictions) moved the caret away from the visible text.
 * With one layer there is nothing to disagree with, and the engine's own
 * predictive text, autocorrect and IME keep working on the real editable node.
 *
 * To MessageComposer the editor looks like the textarea it replaces: the root
 * element carries `value`, `selectionStart`, `selectionEnd` and
 * `setSelectionRange` (see ComposerInputElement), and the editor reports edits
 * and caret moves through the same handlers.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { MentionReference } from '@fluux/sdk'
import {
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  KEY_DOWN_COMMAND,
  createEditor,
  type LexicalEditor,
} from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import type { ComposerAutocompleteAriaProps } from './autocompleteAria'
import type { ComposerInputElement } from './composerInput'
import {
  $getSelectionOffsets,
  $serializeReferences,
  $serializeText,
  $setContent,
  $setSelectionOffsets,
  MentionNode,
} from './roomEditorModel'

/** Update tag for writes that come from the parent, which it must not be told about. */
const EXTERNAL_TAG = 'composer-external'
/** Dispatched on the root when the selection is moved from code rather than by the user. */
const SELECTION_EVENT = 'fluux-selection'
/** How many of the editor's own reports may still be on their way back as `value`. */
const MAX_PENDING_ECHOES = 16

export interface RoomComposerEditorProps {
  /** The draft text (controlled). */
  value: string
  /** The draft's mentions, used whenever `value` is written from outside the editor. */
  references: readonly MentionReference[]
  placeholder: string
  ariaProps: ComposerAutocompleteAriaProps
  /** Receives the root element, which doubles as the composer's input element. */
  mergedRef: (node: ComposerInputElement | null) => void
  /** The editor's own edit: the text and the mentions it now holds. */
  onEdit: (text: string, references: MentionReference[]) => void
  onChange: (e: { target: ComposerInputElement }) => void
  onSelect: (e: { currentTarget: ComposerInputElement }) => void
  onKeyDown: (e: KeyboardEvent) => void
  onPaste?: (e: React.ClipboardEvent<HTMLElement>) => void
}

function referencesKey(references: readonly MentionReference[]): string {
  return references.map((r) => `${r.begin}:${r.end}:${r.uri}`).join('|')
}

/** Give the root the slice of the textarea API MessageComposer reads. */
function exposeInputApi(root: HTMLElement, editor: LexicalEditor): ComposerInputElement {
  const read = <T,>(fn: () => T): T => editor.getEditorState().read(fn)
  const offsets = () => read($getSelectionOffsets)
  const setRange = (start: number, end: number) => {
    editor.update(() => $setSelectionOffsets(start, end), { discrete: true, tag: EXTERNAL_TAG })
    // The selection moved without an edit; selection listeners hear about it
    // through this event, since the update listener skips external writes.
    root.dispatchEvent(new Event(SELECTION_EVENT))
  }
  const bounds = () => offsets() ?? [read($serializeText).length, read($serializeText).length]
  // React restores a focused element's selection around a commit by assigning
  // `selectionStart`/`selectionEnd` whenever the element has them, so they are
  // settable, like a textarea's.
  Object.defineProperties(root, {
    value: { configurable: true, get: () => read($serializeText) },
    selectionStart: {
      configurable: true,
      get: () => bounds()[0],
      set: (start: number) => setRange(start, Math.max(start, bounds()[1])),
    },
    selectionEnd: {
      configurable: true,
      get: () => bounds()[1],
      set: (end: number) => setRange(Math.min(bounds()[0], end), end),
    },
    setSelectionRange: { configurable: true, value: setRange },
  })
  return root as ComposerInputElement
}

export function RoomComposerEditor(props: RoomComposerEditorProps) {
  const { value, references, placeholder, ariaProps } = props
  const rootRef = useRef<HTMLDivElement | null>(null)
  const latest = useRef(props)
  latest.current = props
  const [editor] = useState(() =>
    createEditor({
      namespace: 'room-composer',
      nodes: [MentionNode],
      onError: (error) => {
        console.error('Room composer editor error', error)
      },
    }),
  )
  const [isEmpty, setIsEmpty] = useState(value.length === 0)

  // What the editor last reported, and reports the parent has not echoed back yet.
  const reportedText = useRef(value)
  const pendingEchoes = useRef<string[]>([])
  const reportedSelection = useRef('')
  const appliedReferences = useRef(referencesKey(references))

  // Mount: bind the editor to its element, expose the input API, wire listeners.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const input = exposeInputApi(root, editor)

    const cleanups: Array<() => void> = []
    cleanups.push(registerPlainText(editor))
    cleanups.push(registerHistory(editor, createEmptyHistoryState(), 300))

    // The composer's keyboard handling (Enter sends, menus take arrows, Escape
    // cancels) runs before the editor's own and wins when it claims the key.
    // Lexical's listener sits on the same element and is attached later, so this
    // one fires first; the command below then keeps the editor from acting on a
    // key the composer already handled.
    const onNativeKeyDown = (event: KeyboardEvent) => {
      // A key that confirms or edits an IME composition is not the composer's.
      if (event.isComposing || event.keyCode === 229) return
      latest.current.onKeyDown(event)
    }
    root.addEventListener('keydown', onNativeKeyDown)
    cleanups.push(() => root.removeEventListener('keydown', onNativeKeyDown))
    cleanups.push(
      editor.registerCommand(KEY_DOWN_COMMAND, (event) => event.defaultPrevented, COMMAND_PRIORITY_CRITICAL),
    )

    editor.update(() => $setContent(latest.current.value, latest.current.references), {
      discrete: true,
      tag: EXTERNAL_TAG,
    })
    editor.setRootElement(root)
    editor.setEditable(true)
    latest.current.mergedRef(input)

    cleanups.push(
      editor.registerUpdateListener(({ editorState, tags }) => {
        const [text, refs, selection] = editorState.read(
          () => [$serializeText(), $serializeReferences(), $getSelectionOffsets()] as const,
        )
        setIsEmpty(text.length === 0)
        if (tags.has(EXTERNAL_TAG)) return
        const handlers = latest.current
        if (text !== reportedText.current) {
          reportedText.current = text
          pendingEchoes.current = [...pendingEchoes.current, text].slice(-MAX_PENDING_ECHOES)
          reportedSelection.current = String(selection)
          appliedReferences.current = referencesKey(refs)
          handlers.onEdit(text, refs)
          handlers.onChange({ target: input })
          return
        }
        const key = String(selection)
        if (key !== reportedSelection.current) {
          reportedSelection.current = key
          handlers.onSelect({ currentTarget: input })
        }
      }),
    )
    const onProgrammaticSelection = () => latest.current.onSelect({ currentTarget: input })
    root.addEventListener(SELECTION_EVENT, onProgrammaticSelection)
    cleanups.push(() => root.removeEventListener(SELECTION_EVENT, onProgrammaticSelection))

    return () => {
      cleanups.reverse().forEach((cleanup) => cleanup())
      editor.setRootElement(null)
      latest.current.mergedRef(null)
    }
  }, [editor])

  // A `value` the editor did not produce (draft restore, edit prefill, clearing
  // after send, a mention or emoji inserted by the composer) is written into it.
  // A `value` that is merely the editor's own report coming back — possibly one
  // keystroke behind — must not be, or it would erase what was typed since.
  const referenceKey = referencesKey(references)
  useLayoutEffect(() => {
    const echoIndex = pendingEchoes.current.indexOf(value)
    if (echoIndex !== -1) {
      pendingEchoes.current = pendingEchoes.current.slice(echoIndex + 1)
      return
    }
    const current = editor.getEditorState().read($serializeText)
    if (current === value && appliedReferences.current === referenceKey) return

    const keepCaret = current === value
    const previous = editor.getEditorState().read($getSelectionOffsets)
    editor.update(
      () => {
        $setContent(value, latest.current.references)
        const caret = keepCaret && previous ? Math.min(previous[0], value.length) : value.length
        $setSelectionOffsets(caret, keepCaret && previous ? Math.min(previous[1], value.length) : caret)
      },
      { discrete: true, tag: EXTERNAL_TAG },
    )
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
    reportedText.current = value
    pendingEchoes.current = []
    appliedReferences.current = referenceKey
  }, [value, referenceKey, editor])

  return (
    <>
      {isEmpty && (
        <span
          aria-hidden="true"
          className="message-input-placeholder pointer-events-none absolute inset-y-0 start-0 px-2 truncate text-fluux-muted"
          style={{ lineHeight: '24px' }}
        >
          {placeholder}
        </span>
      )}
      <div
        ref={rootRef}
        // Lexical drives the contents; React must never render children here.
        contentEditable
        suppressContentEditableWarning
        aria-multiline="true"
        aria-placeholder={placeholder}
        spellCheck={true}
        autoCorrect="on"
        autoCapitalize="sentences"
        enterKeyHint="enter"
        onPaste={props.onPaste}
        {...ariaProps}
        className="message-input no-focus-ring flex-1 min-w-0 px-2 bg-transparent overflow-y-auto overflow-x-hidden
                   whitespace-pre-wrap text-fluux-text outline-none"
      />
    </>
  )
}
