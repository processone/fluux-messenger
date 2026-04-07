/**
 * XEP-0393: Message Styling (extended with Markdown compatibility)
 *
 * Renders styled text with support for:
 * - *bold* (XEP-0393 strong) or **bold** (Markdown strong)
 * - _italic_ (emphasis)
 * - ~strikethrough~
 * - `code` (inline preformatted)
 * - ```code block``` (preformatted block)
 * - > blockquote (lines starting with >)
 * - Unordered lists (lines starting with -, +, or * followed by space)
 * - Ordered lists (lines starting with 1., 2., etc.)
 * - Headings (# H1, ## H2, ### H3, #### H4)
 * - URLs (auto-linked)
 * - @mentions (highlighted)
 * - Escape sequences (\* \_ \~ \` \> \#)
 */

import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { findMentionRanges, findIrcPrefixRange, type MentionReference } from '@fluux/sdk'
import { Maximize2 } from 'lucide-react'
import { ModalShell } from '../components/ModalShell'
import { useHighlighter } from './codeHighlight'
import { getConsistentTextColor } from '../components/Avatar'

// URL regex pattern - excludes < and > to handle angle-bracketed URLs like <https://example.com>
const URL_REGEX = /(https?:\/\/[^\s<>]+[^\s<>.,;:!?)"'\]])/g

// Mention regex pattern: @word (must be preceded by start or whitespace)
// Used as fallback when XEP-0372 references aren't available
// Uses Unicode property escapes (\p{L} for letters, \p{N} for numbers) to support
// all valid XMPP nicks including accented, Cyrillic, Chinese, Japanese, etc.
const MENTION_REGEX = /(?:^|(?<=\s))(@[\p{L}\p{N}_]+)/gu

// Escape sequences: \* \_ \~ \` \>
const ESCAPE_PLACEHOLDER = '\u0000'

interface StyledSegment {
  type: 'text' | 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'mention'
  content: string
  /** For mentions: identifier used to generate consistent user color (nick extracted from URI or @text) */
  identifier?: string
}

/** Mention range with optional URI for nick extraction */
interface MentionRange {
  begin: number
  end: number
  uri?: string
}

/**
 * Parse inline styling within a single line/block of text
 * @param text - The text to parse
 * @param mentionRanges - Optional XEP-0372 mention ranges with begin/end positions relative to original text
 * @param textOffset - Offset of this text segment in the original message (for mention position matching)
 */
function parseInlineStyles(
  text: string,
  mentionRanges: MentionRange[] | null = null,
  textOffset: number = 0,
  disableMentionFallback: boolean = false
): StyledSegment[] {
  const segments: StyledSegment[] = []

  // First, handle escape sequences by replacing them with placeholders
  let escaped = text
  const escapeMap: Map<string, string> = new Map()
  let escapeIndex = 0

  escaped = escaped.replace(/\\([*_~`>#])/g, (_, char) => {
    const placeholder = `${ESCAPE_PLACEHOLDER}${escapeIndex}${ESCAPE_PLACEHOLDER}`
    escapeMap.set(placeholder, char)
    escapeIndex++
    return placeholder
  })

  // Split by URLs first
  const urlParts = escaped.split(URL_REGEX)

  // Track position in the original text for mention matching
  let currentPos = textOffset

  for (const part of urlParts) {
    if (URL_REGEX.test(part)) {
      URL_REGEX.lastIndex = 0
      segments.push({ type: 'link', content: restoreEscapes(part, escapeMap) })
      currentPos += part.length
    } else if (part) {
      // Parse mentions and styling in non-URL parts
      parseMentionsAndStyles(part, segments, escapeMap, mentionRanges, currentPos, disableMentionFallback)
      currentPos += part.length
    }
  }

  return segments
}

/**
 * Parse mentions and then styled text
 * Uses XEP-0372 mention ranges when available, falls back to regex detection
 */
/**
 * Extract nick identifier from a mention URI or mention text.
 * XEP-0372 URI: 'xmpp:room@conf/nick' → 'nick'
 * Regex @mention: '@alice' → 'alice'
 * IRC prefix: 'Holger' → 'Holger'
 */
function extractMentionIdentifier(uri?: string, mentionText?: string): string | undefined {
  // Try URI first (XEP-0372)
  if (uri) {
    const slashIndex = uri.indexOf('/')
    if (slashIndex !== -1) {
      return uri.slice(slashIndex + 1)
    }
    // URI without slash (e.g. @all → 'xmpp:room@conf') — no individual user
    return undefined
  }
  // Regex fallback: strip @ prefix
  if (mentionText?.startsWith('@')) {
    return mentionText.slice(1)
  }
  // IRC-style: the mention text IS the nick
  return mentionText || undefined
}

function parseMentionsAndStyles(
  text: string,
  segments: StyledSegment[],
  escapeMap: Map<string, string>,
  mentionRanges: MentionRange[] | null = null,
  textOffset: number = 0,
  disableMentionFallback: boolean = false
): void {
  // If we have XEP-0372 mention ranges, use them for precise highlighting
  if (mentionRanges && mentionRanges.length > 0) {
    const textEnd = textOffset + text.length

    // Find mentions that overlap with this text segment
    const relevantMentions = mentionRanges.filter(m =>
      m.begin < textEnd && m.end > textOffset
    )

    if (relevantMentions.length > 0) {
      // Sort by begin position
      relevantMentions.sort((a, b) => a.begin - b.begin)

      let lastEnd = 0 // Position in the text string (not original message)

      for (const mention of relevantMentions) {
        // Convert from original message positions to text positions
        const mentionStart = Math.max(0, mention.begin - textOffset)
        const mentionEnd = Math.min(text.length, mention.end - textOffset)

        // Skip if mention is completely outside this text segment
        if (mentionStart >= text.length || mentionEnd <= 0) continue

        // Add text before this mention
        if (mentionStart > lastEnd) {
          const before = text.slice(lastEnd, mentionStart)
          parseStyledText(before, segments, escapeMap)
        }

        // Add the mention with identifier for consistent coloring
        const mentionText = text.slice(mentionStart, mentionEnd)
        const identifier = extractMentionIdentifier(mention.uri, mentionText)
        segments.push({ type: 'mention', content: restoreEscapes(mentionText, escapeMap), identifier })

        lastEnd = mentionEnd
      }

      // Add remaining text after last mention
      if (lastEnd < text.length) {
        const after = text.slice(lastEnd)
        parseStyledText(after, segments, escapeMap)
      }

      return
    }
  }

  // Fallback: use regex to detect @mentions (only in room context)
  // In 1:1 chats, no nickname/knownNicks are provided, so we skip the regex fallback
  // to avoid colorizing non-mention @words like "@commit"
  if (disableMentionFallback) {
    parseStyledText(text, segments, escapeMap)
    return
  }

  const mentionParts = text.split(MENTION_REGEX)

  for (const part of mentionParts) {
    if (MENTION_REGEX.test(part)) {
      MENTION_REGEX.lastIndex = 0
      const identifier = extractMentionIdentifier(undefined, part)
      segments.push({ type: 'mention', content: restoreEscapes(part, escapeMap), identifier })
    } else if (part) {
      // Parse styling in non-mention parts
      parseStyledText(part, segments, escapeMap)
    }
  }
}

/**
 * Restore escaped characters from placeholders
 */
function restoreEscapes(text: string, escapeMap: Map<string, string>): string {
  let result = text
  escapeMap.forEach((char, placeholder) => {
    result = result.split(placeholder).join(char)
  })
  return result
}

/**
 * Parse styled text (bold, italic, strikethrough, code)
 */
function parseStyledText(
  text: string,
  segments: StyledSegment[],
  escapeMap: Map<string, string>
): void {
  // Regex for inline styles: **bold** (Markdown), *bold* (XEP-0393), _italic_, ~strike~, `code`
  // Per XEP-0393: markers must be at word boundaries (start/end of string, whitespace, or punctuation)
  // Opening marker: not followed by whitespace
  // Closing marker: not preceded by whitespace
  // Uses lookbehind (?<=...) and lookahead (?=...) for boundary checks
  // IMPORTANT: **bold** patterns must come BEFORE *bold* patterns to match correctly
  const styleRegex = /(?<=^|[\s\p{P}])(\*\*[^\s*][^*]*[^\s*]\*\*|\*\*[^\s*]\*\*|\*[^\s*][^*]*[^\s*]\*|\*[^\s*]\*|_[^\s_][^_]*[^\s_]_|_[^\s_]_|~[^\s~][^~]*[^\s~]~|~[^\s~]~|`[^`]+`)(?=$|[\s\p{P}])/gu

  let lastIndex = 0
  let match

  while ((match = styleRegex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      segments.push({ type: 'text', content: restoreEscapes(before, escapeMap) })
    }

    const styled = match[0]

    // Detect double asterisk (Markdown bold) vs single asterisk (XEP-0393 bold)
    let type: StyledSegment['type'] = 'text'
    let inner: string

    if (styled.startsWith('**') && styled.endsWith('**')) {
      // Markdown-style bold: **text**
      type = 'bold'
      inner = styled.slice(2, -2)
    } else {
      // XEP-0393 style: single character markers
      const marker = styled[0]
      inner = styled.slice(1, -1)

      if (marker === '*') type = 'bold'
      else if (marker === '_') type = 'italic'
      else if (marker === '~') type = 'strike'
      else if (marker === '`') type = 'code'
    }

    segments.push({ type, content: restoreEscapes(inner, escapeMap) })
    lastIndex = match.index + styled.length
  }

  // Add remaining text (or entire text if no matches)
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: restoreEscapes(text.slice(lastIndex), escapeMap) })
  }
}

/**
 * Render a styled segment to React elements
 */
function renderSegment(segment: StyledSegment, index: number, isDarkMode?: boolean): React.ReactNode {
  switch (segment.type) {
    case 'bold':
      return <strong key={index} className="font-semibold">{segment.content}</strong>
    case 'italic':
      return <em key={index}>{segment.content}</em>
    case 'strike':
      return <del key={index} className="line-through opacity-70">{segment.content}</del>
    case 'code':
      return (
        <code
          key={index}
          className="bg-fluux-bg/50 text-fluux-brand px-1.5 py-0.5 rounded text-sm font-mono"
        >
          {segment.content}
        </code>
      )
    case 'link':
      return (
        <a
          key={index}
          href={segment.content}
          target="_blank"
          rel="noopener noreferrer"
          className="text-fluux-link hover:underline"
        >
          {segment.content}
        </a>
      )
    case 'mention': {
      // Use per-user consistent color when identifier is available, otherwise fall back to brand
      const color = segment.identifier
        ? getConsistentTextColor(segment.identifier, isDarkMode ?? true)
        : undefined
      const style = color
        ? { color, backgroundColor: `${color}15` }
        : undefined
      const className = color
        ? 'px-1 rounded font-medium'
        : 'text-fluux-brand bg-fluux-brand/10 px-1 rounded font-medium'
      return (
        <span
          key={index}
          className={className}
          style={style}
          data-mention={segment.identifier || ''}
        >
          {segment.content}
        </span>
      )
    }
    default:
      return segment.content
  }
}

/** Copy text to clipboard with fallback for older browsers */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
}

/** Copy button with checkmark feedback */
function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className={`p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors ${className}`}
      title={copied ? 'Copied!' : 'Copy code'}
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  )
}

/** Rendered code content (plain or syntax-highlighted) */
function CodeContent({ code, highlightedHtml }: { code: string; highlightedHtml: string | null }) {
  return highlightedHtml ? (
    <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  ) : (
    <code>{code}</code>
  )
}

/** Expanded code modal — fullscreen on mobile, large centered panel on desktop */
function CodeExpandModal({
  code,
  language,
  highlightedHtml,
  onClose,
}: {
  code: string
  language?: string
  highlightedHtml: string | null
  onClose: () => void
}) {
  return createPortal(
    <ModalShell
      title={language || 'Code'}
      onClose={onClose}
      width="max-w-5xl"
      panelClassName="max-h-dvh md:max-h-[90vh] h-dvh md:h-auto !mx-0 !rounded-none md:!mx-4 md:!rounded-lg flex flex-col"
    >
      <div className="flex-1 overflow-auto min-h-0">
        <pre className="bg-fluux-bg/50 text-fluux-text px-4 py-3 overflow-x-auto font-mono text-sm min-h-full">
          <CodeContent code={code} highlightedHtml={highlightedHtml} />
        </pre>
      </div>
      <div className="flex justify-end px-3 py-2 border-t border-fluux-hover flex-shrink-0">
        <CopyButton text={code} />
      </div>
    </ModalShell>,
    document.body,
  )
}

/**
 * Code block component with copy button, expand button, and syntax highlighting
 */
function CodeBlock({ code, language, keyProp }: { code: string; language?: string; keyProp: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { ready, highlight } = useHighlighter(language)

  const highlightedHtml = ready && language ? highlight(code, language) : null

  return (
    <>
      <div key={keyProp} className="my-1 rounded-lg overflow-hidden border border-fluux-border">
        {/* Header bar with language label, expand and copy buttons */}
        <div className="flex items-center justify-between px-2 bg-fluux-sidebar border-b border-fluux-border">
          {language ? (
            <span className="text-xs text-fluux-muted select-none py-1">{language}</span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setExpanded(true)}
              className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
              title="Expand code"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <CopyButton text={code} />
          </div>
        </div>
        {/* Code content */}
        <pre className="bg-fluux-bg/50 text-fluux-text px-3 py-2 overflow-x-auto font-mono text-sm">
          <CodeContent code={code} highlightedHtml={highlightedHtml} />
        </pre>
      </div>
      {expanded && (
        <CodeExpandModal
          code={code}
          language={language}
          highlightedHtml={highlightedHtml}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  )
}

/**
 * Check if a line is a blockquote (starts with > )
 */
function isBlockquote(line: string): { isQuote: boolean; depth: number; content: string } {
  const match = line.match(/^(>+)\s?(.*)$/)
  if (match) {
    return { isQuote: true, depth: match[1].length, content: match[2] }
  }
  return { isQuote: false, depth: 0, content: line }
}

/**
 * Check if a line is an unordered list item (starts with -, +, or * followed by space)
 * Note: * must be followed by space to distinguish from *bold* formatting
 */
function isUnorderedListItem(line: string): { isList: boolean; content: string; marker: string } {
  const match = line.match(/^([-+*])\s+(.*)$/)
  if (match) {
    return { isList: true, marker: match[1], content: match[2] }
  }
  return { isList: false, marker: '', content: line }
}

/**
 * Check if a line is an ordered list item (starts with number. followed by space)
 */
function isOrderedListItem(line: string): { isList: boolean; number: number; content: string } {
  const match = line.match(/^(\d+)\.\s+(.*)$/)
  if (match) {
    return { isList: true, number: parseInt(match[1], 10), content: match[2] }
  }
  return { isList: false, number: 0, content: line }
}

/**
 * Check if a line is a heading (starts with # followed by space)
 * Supports levels 1-4 (# through ####)
 */
function isHeading(line: string): { isHeading: boolean; level: number; content: string } {
  const match = line.match(/^(#{1,4})\s+(.+)$/)
  if (match) {
    return { isHeading: true, level: match[1].length, content: match[2] }
  }
  return { isHeading: false, level: 0, content: line }
}

/**
 * Render text with clickable links only (no other styling)
 * Useful for room subjects and other simple text that may contain URLs
 */
export function renderTextWithLinks(text: string): React.ReactNode {
  if (!text) return null

  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match

  // Reset regex state
  URL_REGEX.lastIndex = 0

  while ((match = URL_REGEX.exec(text)) !== null) {
    // Add text before the URL
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    // Add the URL as a clickable link
    const url = match[0]
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-fluux-link hover:underline"
      >
        {url}
      </a>
    )

    lastIndex = match.index + url.length
  }

  // Add remaining text after last URL
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  // If no links found, just return the text
  if (parts.length === 0) {
    return text
  }

  return parts
}

/**
 * Parse and render a complete message with all styling
 * @param text - The message body
 * @param mentions - Optional XEP-0372 mention references for precise highlighting
 * @param nickname - Optional user nickname for IRC-style mention detection fallback
 */
export function renderStyledMessage(text: string, mentions?: MentionReference[], nickname?: string, knownNicks?: ReadonlySet<string>, isDarkMode?: boolean): React.ReactNode {
  // Normalize line endings: CRLF -> LF, CR -> LF
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // If we have XEP-0372 mentions, use them for precise highlighting.
  // Otherwise, try IRC-style mention detection if a nickname is provided.
  // Final fallback: the regex in parseInlineStyles detects @mention patterns.
  let mentionRanges: MentionRange[] | null = null
  if (mentions && mentions.length > 0) {
    mentionRanges = mentions.map(m => ({ begin: m.begin, end: m.end, uri: m.uri })).sort((a, b) => a.begin - b.begin)
  } else if (nickname) {
    const detected = findMentionRanges(normalizedText, nickname)
    mentionRanges = detected.length > 0 ? detected : null
  }

  // When no XEP-0372 mentions, also detect IRC-style prefix mention for known occupants
  // (e.g., "Holger:" or "raver," at message start) for visual highlighting
  if ((!mentions || mentions.length === 0) && knownNicks && knownNicks.size > 0) {
    const ircRange = findIrcPrefixRange(normalizedText, knownNicks)
    if (ircRange) {
      if (!mentionRanges) {
        mentionRanges = [ircRange]
      } else {
        const overlaps = mentionRanges.some(r => r.begin < ircRange.end && r.end > ircRange.begin)
        if (!overlaps) {
          mentionRanges = [...mentionRanges, ircRange].sort((a, b) => a.begin - b.begin)
        }
      }
    }
  }

  // In 1:1 chats (no mentions, no nickname, no knownNicks), disable the regex
  // fallback that colorizes any @word — only colorize actual user mentions
  const disableMentionFallback = (!mentions || mentions.length === 0) && !nickname && (!knownNicks || knownNicks.size === 0)

  // Check for code blocks first (```lang\n ... ```)
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match
  let partIndex = 0

  while ((match = codeBlockRegex.exec(normalizedText)) !== null) {
    // Render text before code block
    if (match.index > lastIndex) {
      const before = normalizedText.slice(lastIndex, match.index)
      parts.push(...renderTextBlock(before, partIndex, mentionRanges, lastIndex, isDarkMode, disableMentionFallback))
      partIndex += 100 // Leave room for sub-indices
    }

    // Render code block with copy button and optional syntax highlighting
    const lang = match[1] || undefined
    const codeContent = match[2].trim()
    parts.push(
      <CodeBlock key={`code-${partIndex++}`} code={codeContent} language={lang} keyProp={`code-${partIndex}`} />
    )

    lastIndex = match.index + match[0].length
  }

  // Render remaining text
  if (lastIndex < normalizedText.length) {
    parts.push(...renderTextBlock(normalizedText.slice(lastIndex), partIndex, mentionRanges, lastIndex, isDarkMode, disableMentionFallback))
  }

  // If no code blocks, render the whole thing
  if (parts.length === 0) {
    return renderTextBlock(normalizedText, 0, mentionRanges, 0, isDarkMode, disableMentionFallback)
  }

  return parts
}

/**
 * Render a text block (handles blockquotes, lists, and inline styles)
 */
function renderTextBlock(
  text: string,
  startIndex: number,
  mentionRanges: MentionRange[] | null = null,
  textOffset: number = 0,
  isDarkMode?: boolean,
  disableMentionFallback: boolean = false
): React.ReactNode[] {
  const lines = text.split('\n')
  const result: React.ReactNode[] = []
  let quoteBuffer: { depth: number; content: string; offset: number }[] | null = null
  let ulBuffer: { lines: string[]; lineOffsets: number[] } | null = null
  let olBuffer: { items: { number: number; content: string; offset: number }[] } | null = null
  let index = startIndex
  let currentOffset = textOffset

  const renderQuoteBlock = (
    entries: { depth: number; content: string; offset: number }[],
    currentDepth: number,
    baseIdx: number
  ): React.ReactNode => {
    const children: React.ReactNode[] = []
    let i = 0

    while (i < entries.length) {
      const entry = entries[i]
      if (entry.depth <= currentDepth) {
        // Render this line at the current depth
        // Add <br/> between consecutive same-depth lines
        if (children.length > 0 && i > 0 && entries[i - 1].depth <= currentDepth) {
          children.push(<br key={`br-${baseIdx + i}`} />)
        }
        children.push(
          <React.Fragment key={`line-${baseIdx + i}`}>
            {renderInline(entry.content, baseIdx + i, mentionRanges, entry.offset, isDarkMode, disableMentionFallback)}
          </React.Fragment>
        )
        i++
      } else {
        // Collect consecutive deeper lines and render as nested blockquote
        const nestedStart = i
        while (i < entries.length && entries[i].depth > currentDepth) {
          i++
        }
        children.push(renderQuoteBlock(entries.slice(nestedStart, i), currentDepth + 1, baseIdx + nestedStart))
      }
    }

    const isOutermost = currentDepth === 1
    return (
      <blockquote
        key={`quote-${baseIdx}`}
        className={isOutermost ? 'blockquote-decorated text-fluux-muted italic' : 'blockquote-nested text-fluux-muted italic'}
      >
        {children}
      </blockquote>
    )
  }

  const flushQuote = () => {
    if (quoteBuffer && quoteBuffer.length > 0) {
      result.push(renderQuoteBlock(quoteBuffer, 1, index))
      index += quoteBuffer.length
      quoteBuffer = null
    }
  }

  const flushUnorderedList = () => {
    if (ulBuffer && ulBuffer.lines.length > 0) {
      result.push(
        <ul
          key={`ul-${index++}`}
          className="list-disc list-inside my-1 space-y-0.5"
        >
          {ulBuffer.lines.map((line, i) => (
            <li key={i} className="text-fluux-text">
              {renderInline(line, index + i, mentionRanges, ulBuffer!.lineOffsets[i], isDarkMode, disableMentionFallback)}
            </li>
          ))}
        </ul>
      )
      index += ulBuffer.lines.length
      ulBuffer = null
    }
  }

  const flushOrderedList = () => {
    if (olBuffer && olBuffer.items.length > 0) {
      // Use the first item's number as the start attribute
      const startNum = olBuffer.items[0].number
      result.push(
        <ol
          key={`ol-${index++}`}
          start={startNum}
          className="list-decimal list-inside my-1 space-y-0.5"
        >
          {olBuffer.items.map((item, i) => (
            <li key={i} className="text-fluux-text">
              {renderInline(item.content, index + i, mentionRanges, item.offset, isDarkMode, disableMentionFallback)}
            </li>
          ))}
        </ol>
      )
      index += olBuffer.items.length
      olBuffer = null
    }
  }

  const flushAllBuffers = () => {
    flushQuote()
    flushUnorderedList()
    flushOrderedList()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineOffset = currentOffset

    // Check for blockquote first
    const quoteCheck = isBlockquote(line)
    if (quoteCheck.isQuote) {
      // Flush other buffers before starting/continuing quote
      flushUnorderedList()
      flushOrderedList()

      if (!quoteBuffer) {
        quoteBuffer = []
      }
      const prefixLength = line.length - quoteCheck.content.length
      quoteBuffer.push({ depth: quoteCheck.depth, content: quoteCheck.content, offset: lineOffset + prefixLength })
      currentOffset += line.length + 1
      continue
    }

    // Check for unordered list item
    const ulCheck = isUnorderedListItem(line)
    if (ulCheck.isList) {
      // Flush other buffers before starting/continuing unordered list
      flushQuote()
      flushOrderedList()

      if (!ulBuffer) {
        ulBuffer = { lines: [], lineOffsets: [] }
      }
      const prefixLength = line.length - ulCheck.content.length
      ulBuffer.lines.push(ulCheck.content)
      ulBuffer.lineOffsets.push(lineOffset + prefixLength)
      currentOffset += line.length + 1
      continue
    }

    // Check for ordered list item
    const olCheck = isOrderedListItem(line)
    if (olCheck.isList) {
      // Flush other buffers before starting/continuing ordered list
      flushQuote()
      flushUnorderedList()

      if (!olBuffer) {
        olBuffer = { items: [] }
      }
      const prefixLength = line.length - olCheck.content.length
      olBuffer.items.push({
        number: olCheck.number,
        content: olCheck.content,
        offset: lineOffset + prefixLength
      })
      currentOffset += line.length + 1
      continue
    }

    // Check for heading (# Title, ## Subtitle, etc.)
    const headingCheck = isHeading(line)
    if (headingCheck.isHeading) {
      flushAllBuffers()

      const level = headingCheck.level
      const prefixLength = line.length - headingCheck.content.length
      const headingClasses =
        level === 1 ? 'text-lg font-bold' :
        level === 2 ? 'text-base font-semibold' :
        'text-sm font-semibold'

      result.push(
        <div key={`heading-${index++}`} className={`${headingClasses} mt-1`}>
          {renderInline(headingCheck.content, index, mentionRanges, lineOffset + prefixLength, isDarkMode, disableMentionFallback)}
        </div>
      )

      currentOffset += line.length + 1
      continue
    }

    // Regular line - flush all buffers first
    flushAllBuffers()

    if (line || i < lines.length - 1) {
      result.push(
        <React.Fragment key={`line-${index++}`}>
          {renderInline(line, index, mentionRanges, lineOffset, isDarkMode, disableMentionFallback)}
          {i < lines.length - 1 && <br />}
        </React.Fragment>
      )
    }

    currentOffset += line.length + 1
  }

  // Flush any remaining buffers
  flushAllBuffers()
  return result
}

/**
 * Render inline styled text
 */
function renderInline(
  text: string,
  keyBase: number,
  mentionRanges: MentionRange[] | null = null,
  textOffset: number = 0,
  isDarkMode?: boolean,
  disableMentionFallback: boolean = false
): React.ReactNode {
  if (!text) return null
  const segments = parseInlineStyles(text, mentionRanges, textOffset, disableMentionFallback)
  if (segments.length === 1 && segments[0].type === 'text') {
    return segments[0].content
  }
  return segments.map((seg, i) => renderSegment(seg, keyBase * 1000 + i, isDarkMode))
}
