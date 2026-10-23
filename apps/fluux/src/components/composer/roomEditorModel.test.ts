/**
 * Intent: the room composer's single-layer editor must hand the rest of the app
 * the same draft it always had — a plain string plus `MentionReference[]` — and
 * must take such a draft back (draft restore, mention insertion) without
 * shifting any mention off its text. Real Lexical state, no DOM needed.
 */
import { describe, expect, it } from 'vitest'
import { createEditor, type LexicalEditor } from 'lexical'
import type { MentionReference } from '@fluux/sdk'
import {
  $getSelectionOffsets,
  $serializeReferences,
  $serializeText,
  $setContent,
  $setSelectionOffsets,
  MentionNode,
} from './roomEditorModel'
import { reconcileReferences } from './reconcileReferences'

function makeEditor(): LexicalEditor {
  return createEditor({ namespace: 'test', nodes: [MentionNode], onError: (e) => { throw e } })
}

function load(editor: LexicalEditor, text: string, references: MentionReference[] = []) {
  editor.update(() => $setContent(text, references), { discrete: true })
}

const read = <T,>(editor: LexicalEditor, fn: () => T): T => editor.getEditorState().read(fn)

const mention = (begin: number, end: number, uri = 'xmpp:team@conference.example/nick'): MentionReference =>
  ({ begin, end, type: 'mention', uri })

describe('room editor document model', () => {
  it('round-trips text, line breaks, emoji and mentions', () => {
    const editor = makeEditor()
    const text = 'Thanks 👍 @Emma\n\nsee you @all tomorrow\n'
    const refs = [mention(9, 14), mention(27, 31, 'xmpp:team@conference.example')]
    load(editor, text, refs)

    expect(read(editor, $serializeText)).toBe(text)
    expect(read(editor, $serializeReferences)).toEqual(refs)
  })

  it('ignores references that do not describe a range of the text', () => {
    const editor = makeEditor()
    load(editor, 'hi @Emma', [mention(3, 8), mention(5, 20), mention(6, 6), mention(4, 7)])

    // Only the first is well-formed; the overlapping and out-of-range ones are dropped.
    expect(read(editor, $serializeReferences)).toEqual([mention(3, 8)])
    expect(read(editor, $serializeText)).toBe('hi @Emma')
  })

  it('maps selection offsets to editor points and back, never splitting a mention', () => {
    const editor = makeEditor()
    load(editor, 'a\nbc @Emma d', [mention(5, 10)])

    for (const offset of [0, 1, 2, 3, 4, 5, 10, 11, 12]) {
      editor.update(() => $setSelectionOffsets(offset, offset), { discrete: true })
      expect(read(editor, $getSelectionOffsets)).toEqual([offset, offset])
    }

    // Inside a mention the caret snaps to the nearer edge.
    editor.update(() => $setSelectionOffsets(6, 6), { discrete: true })
    expect(read(editor, $getSelectionOffsets)).toEqual([5, 5])
    editor.update(() => $setSelectionOffsets(9, 9), { discrete: true })
    expect(read(editor, $getSelectionOffsets)).toEqual([10, 10])
  })

  it('keeps a selected range across a line break and a mention', () => {
    const editor = makeEditor()
    load(editor, 'a\nbc @Emma d', [mention(5, 10)])
    editor.update(() => $setSelectionOffsets(1, 11), { discrete: true })
    expect(read(editor, $getSelectionOffsets)).toEqual([1, 11])
  })
})

describe('reconcileReferences', () => {
  it('shifts mentions after an insertion made outside the editor (emoji at the caret)', () => {
    const before = 'hi @Emma and @Noah'
    const after = 'hi 👍 @Emma and @Noah'
    const shifted = reconcileReferences(before, after, [mention(3, 8), mention(13, 18)])
    expect(shifted).toEqual([mention(6, 11), mention(16, 21)])
    expect(after.slice(shifted[1].begin, shifted[1].end)).toBe('@Noah')
  })

  it('drops a mention the rewrite touched and keeps the rest', () => {
    const shifted = reconcileReferences('@Emma and @Noah', '@Em and @Noah', [mention(0, 5), mention(10, 15)])
    expect(shifted).toEqual([mention(8, 13)])
  })

  it('returns the same mentions when nothing changed', () => {
    const refs = [mention(0, 5)]
    expect(reconcileReferences('@Emma', '@Emma', refs)).toEqual(refs)
  })
})
