/**
 * XEP-0393: Message Styling
 *
 * Renders styled text with support for:
 * - *bold* (strong)
 * - _italic_ (emphasis)
 * - ~strikethrough~
 * - `code` (inline preformatted)
 * - ```code block``` (preformatted block)
 * - > blockquote (lines starting with >)
 * - URLs (auto-linked)
 * - @mentions (highlighted)
 * - Escape sequences (\* \_ \~ \` \>)
 */

import React, { useState } from 'react'
import type { MentionReference } from '@fluux/sdk'

// URL regex pattern
const URL_REGEX = /(https?:\/\/[^\s<]+[^\s<.,;:!?)"'\]])/g

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
}

/**
 * Parse inline styling within a single line/block of text
 * @param text - The text to parse
 * @param mentionRanges - Optional XEP-0372 mention ranges with begin/end positions relative to original text
 * @param textOffset - Offset of this text segment in the original message (for mention position matching)
 */
function parseInlineStyles(
  text: string,
  mentionRanges: { begin: number; end: number }[] | null = null,
  textOffset: number = 0
): StyledSegment[] {
  const segments: StyledSegment[] = []

  // First, handle escape sequences by replacing them with placeholders
  let escaped = text
  const escapeMap: Map<string, string> = new Map()
  let escapeIndex = 0

  escaped = escaped.replace(/\\([*_~`>])/g, (_, char) => {
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
      parseMentionsAndStyles(part, segments, escapeMap, mentionRanges, currentPos)
      currentPos += part.length
    }
  }

  return segments
}

/**
 * Parse mentions and then styled text
 * Uses XEP-0372 mention ranges when available, falls back to regex detection
 */
function parseMentionsAndStyles(
  text: string,
  segments: StyledSegment[],
  escapeMap: Map<string, string>,
  mentionRanges: { begin: number; end: number }[] | null = null,
  textOffset: number = 0
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

        // Add the mention
        const mentionText = text.slice(mentionStart, mentionEnd)
        segments.push({ type: 'mention', content: restoreEscapes(mentionText, escapeMap) })

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

  // Fallback: use regex to detect @mentions
  const mentionParts = text.split(MENTION_REGEX)

  for (const part of mentionParts) {
    if (MENTION_REGEX.test(part)) {
      MENTION_REGEX.lastIndex = 0
      segments.push({ type: 'mention', content: restoreEscapes(part, escapeMap) })
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
  // Regex for inline styles: *bold*, _italic_, ~strike~, `code`
  // Per XEP-0393: markers must be at word boundaries (start/end of string, whitespace, or punctuation)
  // Opening marker: not followed by whitespace
  // Closing marker: not preceded by whitespace
  // Uses lookbehind (?<=...) and lookahead (?=...) for boundary checks
  const styleRegex = /(?<=^|[\s\p{P}])(\*[^\s*][^*]*[^\s*]\*|\*[^\s*]\*|_[^\s_][^_]*[^\s_]_|_[^\s_]_|~[^\s~][^~]*[^\s~]~|~[^\s~]~|`[^`]+`)(?=$|[\s\p{P}])/gu

  let lastIndex = 0
  let match

  while ((match = styleRegex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      segments.push({ type: 'text', content: restoreEscapes(before, escapeMap) })
    }

    const styled = match[0]
    const marker = styled[0]
    const inner = styled.slice(1, -1)

    let type: StyledSegment['type'] = 'text'
    if (marker === '*') type = 'bold'
    else if (marker === '_') type = 'italic'
    else if (marker === '~') type = 'strike'
    else if (marker === '`') type = 'code'

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
function renderSegment(segment: StyledSegment, index: number): React.ReactNode {
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
    case 'mention':
      return (
        <span
          key={index}
          className="text-fluux-brand bg-fluux-brand/10 px-1 rounded font-medium"
        >
          {segment.content}
        </span>
      )
    default:
      return segment.content
  }
}

/**
 * Code block component with copy button
 */
function CodeBlock({ code, keyProp }: { code: string; keyProp: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = code
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div key={keyProp} className="relative group my-2">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded bg-fluux-bg/80 hover:bg-fluux-bg text-fluux-muted hover:text-fluux-text opacity-0 group-hover:opacity-100 transition-opacity"
        title={copied ? 'Copied!' : 'Copy code'}
      >
        {copied ? (
          <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>
      <pre className="bg-fluux-bg/50 text-fluux-text p-3 pr-10 rounded-lg overflow-x-auto font-mono text-sm">
        <code>{code}</code>
      </pre>
    </div>
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
 */
export function renderStyledMessage(text: string, mentions?: MentionReference[]): React.ReactNode {
  // Normalize line endings: CRLF -> LF, CR -> LF
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // If we have XEP-0372 mentions, use them for precise highlighting
  // Otherwise, the regex fallback in parseInlineStyles will be used
  const mentionRanges = mentions && mentions.length > 0
    ? mentions.map(m => ({ begin: m.begin, end: m.end })).sort((a, b) => a.begin - b.begin)
    : null

  // Check for code blocks first (``` ... ```)
  const codeBlockRegex = /```([\s\S]*?)```/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match
  let partIndex = 0

  while ((match = codeBlockRegex.exec(normalizedText)) !== null) {
    // Render text before code block
    if (match.index > lastIndex) {
      const before = normalizedText.slice(lastIndex, match.index)
      parts.push(...renderTextBlock(before, partIndex, mentionRanges, lastIndex))
      partIndex += 100 // Leave room for sub-indices
    }

    // Render code block with copy button
    const codeContent = match[1].trim()
    parts.push(
      <CodeBlock key={`code-${partIndex++}`} code={codeContent} keyProp={`code-${partIndex}`} />
    )

    lastIndex = match.index + match[0].length
  }

  // Render remaining text
  if (lastIndex < normalizedText.length) {
    parts.push(...renderTextBlock(normalizedText.slice(lastIndex), partIndex, mentionRanges, lastIndex))
  }

  // If no code blocks, render the whole thing
  if (parts.length === 0) {
    return renderTextBlock(normalizedText, 0, mentionRanges, 0)
  }

  return parts
}

/**
 * Render a text block (handles blockquotes and inline styles)
 */
function renderTextBlock(
  text: string,
  startIndex: number,
  mentionRanges: { begin: number; end: number }[] | null = null,
  textOffset: number = 0
): React.ReactNode[] {
  const lines = text.split('\n')
  const result: React.ReactNode[] = []
  let quoteBuffer: { depth: number; lines: string[]; lineOffsets: number[] } | null = null
  let index = startIndex
  let currentOffset = textOffset

  const flushQuote = () => {
    if (quoteBuffer && quoteBuffer.lines.length > 0) {
      result.push(
        <blockquote
          key={`quote-${index++}`}
          className="border-l-4 border-fluux-brand pl-3 my-1 text-fluux-muted italic"
        >
          {quoteBuffer.lines.map((line, i) => (
            <React.Fragment key={i}>
              {renderInline(line, index + i, mentionRanges, quoteBuffer!.lineOffsets[i])}
              {i < quoteBuffer!.lines.length - 1 && <br />}
            </React.Fragment>
          ))}
        </blockquote>
      )
      index += quoteBuffer.lines.length
      quoteBuffer = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const { isQuote, content } = isBlockquote(line)
    const lineOffset = currentOffset

    if (isQuote) {
      if (!quoteBuffer) {
        quoteBuffer = { depth: 1, lines: [], lineOffsets: [] }
      }
      // The content starts after "> " so adjust offset
      const prefixLength = line.length - content.length
      quoteBuffer.lines.push(content)
      quoteBuffer.lineOffsets.push(lineOffset + prefixLength)
    } else {
      flushQuote()
      if (line || i < lines.length - 1) {
        result.push(
          <React.Fragment key={`line-${index++}`}>
            {renderInline(line, index, mentionRanges, lineOffset)}
            {i < lines.length - 1 && <br />}
          </React.Fragment>
        )
      }
    }

    // Move offset past this line + newline character
    currentOffset += line.length + 1
  }

  flushQuote()
  return result
}

/**
 * Render inline styled text
 */
function renderInline(
  text: string,
  keyBase: number,
  mentionRanges: { begin: number; end: number }[] | null = null,
  textOffset: number = 0
): React.ReactNode {
  if (!text) return null
  const segments = parseInlineStyles(text, mentionRanges, textOffset)
  if (segments.length === 1 && segments[0].type === 'text') {
    return segments[0].content
  }
  return segments.map((seg, i) => renderSegment(seg, keyBase * 1000 + i))
}
