import { useCallback, useRef, useState } from 'react'
import type { MentionReference } from '@fluux/sdk'
import { reconcileReferences } from './reconcileReferences'

/**
 * A room draft's mentions, kept consistent with its text.
 *
 * The editor reports its own edits together with the mentions it holds, so those
 * need no bookkeeping. Any other rewrite of the draft (a mention or emoji the
 * composer inserts, a completed :shortcode:) moves the mentions that follow it,
 * so their offsets are carried across the change. Offsets are only meaningful
 * for the text they were taken from, so that text is remembered next to them and
 * is the base of every reconciliation — not whatever text React last rendered.
 */
export function useMentionReferences(setText: (text: string) => void) {
  const [references, setReferences] = useState<MentionReference[]>([])
  const sourceText = useRef('')
  const editorText = useRef<string | null>(null)

  const handleEditorEdit = useCallback((text: string, edited: MentionReference[]) => {
    editorText.current = text
    sourceText.current = text
    setReferences(edited)
  }, [])

  const handleValueChange = useCallback((next: string) => {
    setText(next)
    if (next === editorText.current) return
    const from = sourceText.current
    sourceText.current = next
    setReferences((prev) => reconcileReferences(from, next, prev))
  }, [setText])

  /** The composer replaced the draft with `newText`, which now ends in `reference`. */
  const insertMention = useCallback((newText: string, reference: MentionReference) => {
    const from = sourceText.current
    sourceText.current = newText
    setText(newText)
    setReferences((prev) => [...reconcileReferences(from, newText, prev), reference])
  }, [setText])

  return { references, setReferences, handleEditorEdit, handleValueChange, insertMention }
}
