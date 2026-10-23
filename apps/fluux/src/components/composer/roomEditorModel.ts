/**
 * Document model of the room composer's single-layer editor.
 *
 * The editor is a Lexical contenteditable: text, caret and mention colour share
 * one layout, so they cannot drift apart. Everything the rest of the app knows
 * about a draft is a plain string plus `MentionReference[]` offsets, so this
 * module is the only place that translates between that and Lexical nodes.
 *
 * Text model: the draft is one paragraph whose children are text, line breaks
 * and mentions. A paste or an engine that produces several paragraphs still
 * serializes correctly — paragraph boundaries read as `\n`.
 */
import type { MentionReference } from '@fluux/sdk'
import { CONTROL_CHAR_RE } from '@/utils/tauriInputFix'
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type PointType,
  type SerializedTextNode,
  type Spread,
} from 'lexical'

type SerializedMentionNode = Spread<{ uri: string }, SerializedTextNode>

/**
 * A completed `@nick` mention. A token node: the caret treats it as one unit,
 * Backspace/Delete remove all of it, and typing next to it never extends it.
 */
export class MentionNode extends TextNode {
  __uri: string

  static getType(): string {
    return 'mention'
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__text, node.__uri, node.__key)
  }

  static importJSON(json: SerializedMentionNode): MentionNode {
    return $createMentionNode(json.text, json.uri)
  }

  constructor(text: string, uri: string, key?: NodeKey) {
    super(text, key)
    this.__uri = uri
  }

  exportJSON(): SerializedMentionNode {
    return { ...super.exportJSON(), type: 'mention', uri: this.__uri }
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    dom.className = 'text-fluux-brand'
    dom.dataset.mention = ''
    return dom
  }

  getUri(): string {
    return this.getLatest().__uri
  }

  canInsertTextBefore(): boolean {
    return false
  }

  canInsertTextAfter(): boolean {
    return false
  }

  isTextEntity(): true {
    return true
  }
}

export function $createMentionNode(text: string, uri: string): MentionNode {
  const node = new MentionNode(text, uri)
  node.setMode('token')
  return node
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode
}

/** The text of `node` as it appears in the serialized draft. */
function $nodeLength(node: LexicalNode): number {
  if ($isLineBreakNode(node)) return 1
  return node.getTextContentSize()
}

/** The draft as a plain string. */
export function $serializeText(): string {
  const paragraphs = $getRoot().getChildren()
  let out = ''
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) out += '\n'
    if (!$isElementNode(paragraph)) {
      out += paragraph.getTextContent()
      return
    }
    for (const child of paragraph.getChildren()) {
      out += $isLineBreakNode(child) ? '\n' : child.getTextContent()
    }
  })
  return out
}

/** The draft's mentions with their offsets in the serialized text. */
export function $serializeReferences(): MentionReference[] {
  const references: MentionReference[] = []
  let offset = 0
  $getRoot().getChildren().forEach((paragraph, index) => {
    if (index > 0) offset += 1
    if (!$isElementNode(paragraph)) {
      offset += paragraph.getTextContentSize()
      return
    }
    for (const child of paragraph.getChildren()) {
      const length = $nodeLength(child)
      if ($isMentionNode(child)) {
        references.push({ begin: offset, end: offset + length, type: 'mention', uri: child.getUri() })
      }
      offset += length
    }
  })
  return references
}

/**
 * Replace the whole document. References that do not describe a well-formed
 * range of `text` (out of bounds, overlapping, empty) are ignored rather than
 * painted over the wrong characters.
 */
export function $setContent(text: string, references: readonly MentionReference[]): void {
  const root = $getRoot()
  root.clear()
  const paragraph = $createParagraphNode()
  root.append(paragraph)

  const appendPlain = (chunk: string) => {
    chunk.split('\n').forEach((line, index) => {
      if (index > 0) paragraph.append($createLineBreakNode())
      if (line) paragraph.append($createTextNode(line))
    })
  }

  let cursor = 0
  for (const ref of [...references].sort((a, b) => a.begin - b.begin)) {
    if (ref.begin < cursor || ref.end <= ref.begin || ref.end > text.length) continue
    appendPlain(text.slice(cursor, ref.begin))
    paragraph.append($createMentionNode(text.slice(ref.begin, ref.end), ref.uri))
    cursor = ref.end
  }
  appendPlain(text.slice(cursor))
}

/** Offset in the serialized text of a selection point, or 0 if it is outside the draft. */
function $pointToOffset(point: PointType): number {
  const target = point.getNode()
  const root = $getRoot()
  if (target.is(root)) {
    let offset = 0
    root.getChildren().slice(0, point.offset).forEach((p, i) => {
      offset += (i > 0 ? 1 : 0) + p.getTextContentSize()
    })
    return offset
  }
  let offset = 0
  const paragraphs = root.getChildren()
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]
    if (i > 0) offset += 1
    if (paragraph.is(target) && $isElementNode(paragraph)) {
      return offset + paragraph.getChildren().slice(0, point.offset).reduce((n, c) => n + $nodeLength(c), 0)
    }
    if (!$isElementNode(paragraph)) {
      if (paragraph.is(target)) return offset + point.offset
      offset += paragraph.getTextContentSize()
      continue
    }
    for (const child of paragraph.getChildren()) {
      if (child.is(target)) return offset + (point.type === 'text' ? point.offset : 0)
      offset += $nodeLength(child)
    }
  }
  return offset
}

/** The selection as `[start, end]` offsets in the serialized text, or null with no selection. */
export function $getSelectionOffsets(): [number, number] | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return null
  const a = $pointToOffset(selection.anchor)
  const b = $pointToOffset(selection.focus)
  return a <= b ? [a, b] : [b, a]
}

/** A selection point at `offset` in the serialized text. A mention is never split. */
function $offsetToPoint(offset: number, point: PointType): void {
  const root = $getRoot()
  let position = 0
  const paragraphs = root.getChildren()
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]
    if (i > 0) position += 1
    if (!$isElementNode(paragraph)) continue
    const children = paragraph.getChildren()
    for (let c = 0; c < children.length; c++) {
      const child = children[c]
      const length = $nodeLength(child)
      if ($isLineBreakNode(child)) {
        if (offset <= position) {
          point.set(paragraph.getKey(), c, 'element')
          return
        }
      } else if (offset <= position + length) {
        const inside = offset - position
        point.set(child.getKey(), $isMentionNode(child) ? (inside < length / 2 ? 0 : length) : inside, 'text')
        return
      }
      position += length
    }
    if (offset <= position) {
      point.set(paragraph.getKey(), children.length, 'element')
      return
    }
  }
  const last = paragraphs[paragraphs.length - 1]
  if (last && $isElementNode(last)) point.set(last.getKey(), last.getChildrenSize(), 'element')
  else point.set(root.getKey(), root.getChildrenSize(), 'element')
}

/** Remove C0 control characters (and DEL) from every text node, keeping the selection on its text. */
export function $stripControlChars(): void {
  const text = $serializeText()
  const selection = $getSelectionOffsets()
  const pattern = new RegExp(CONTROL_CHAR_RE.source, 'g')
  const shift = (offset: number) => offset - (text.slice(0, offset).match(pattern)?.length ?? 0)
  const visit = (node: LexicalNode) => {
    if ($isElementNode(node)) node.getChildren().forEach(visit)
    else if ($isTextNode(node)) {
      const clean = node.getTextContent().replace(pattern, '')
      if (clean !== node.getTextContent()) node.setTextContent(clean)
    }
  }
  $getRoot().getChildren().forEach(visit)
  if (selection) $setSelectionOffsets(shift(selection[0]), shift(selection[1]))
}

/** Select `[start, end]` (offsets in the serialized text). */
export function $setSelectionOffsets(start: number, end: number): void {
  const selection = $createRangeSelection()
  $offsetToPoint(start, selection.anchor)
  $offsetToPoint(end, selection.focus)
  $setSelection(selection)
}
