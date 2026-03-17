/**
 * XEP-0428 Fallback Indication Utilities
 *
 * Shared utilities for processing fallback text in XMPP messages.
 * Used by both live message handling (MessageHandler) and MAM queries (XMPPClient).
 *
 * Supports multiple fallback elements per stanza (e.g., reactions + reply).
 * When processing, fallbacks are matched by their 'for' attribute against
 * the caller's validTargets list.
 *
 * Priority order for fallback processing:
 *   1. Entire-body fallbacks (no range) — e.g., reactions fallback
 *   2. Range-based fallbacks — e.g., reply, OOB, correction
 * Range-based fallbacks are applied from end-to-start to preserve indices.
 */

import type { Element } from '@xmpp/client'
import { NS_FALLBACK, NS_FALLBACK_LEGACY, NS_REPLY } from '../core/namespaces'

export interface FallbackProcessingResult {
  processedBody: string
  fallbackBody?: string // For replies - extracted fallback text when original not found
}

export interface FallbackProcessingOptions {
  /** Valid 'for' attribute values to process (e.g., NS_REPLY, NS_OOB, NS_CORRECTION) */
  validTargets: string[]
  /** How to clean whitespace after stripping fallback text */
  trimMode?: 'full' | 'leading-newlines'
}

/**
 * Get ALL fallback elements from a stanza, checking both standard and legacy namespaces.
 * Returns elements from the standard namespace (urn:xmpp:fallback:0) first.
 * Falls back to legacy namespace (urn:xmpp:feature-fallback:0) only if no standard ones found.
 */
export function getAllFallbackElements(stanza: Element): Array<{ element: Element; namespace: string }> {
  const results: Array<{ element: Element; namespace: string }> = []

  // Collect standard namespace fallbacks
  for (const child of stanza.getChildren('fallback')) {
    if ((child as Element).attrs?.xmlns === NS_FALLBACK) {
      results.push({ element: child as Element, namespace: NS_FALLBACK })
    }
  }

  // Fall back to legacy namespace only if no standard ones found
  if (results.length === 0) {
    for (const child of stanza.getChildren('fallback')) {
      if ((child as Element).attrs?.xmlns === NS_FALLBACK_LEGACY) {
        results.push({ element: child as Element, namespace: NS_FALLBACK_LEGACY })
      }
    }
  }

  return results
}

/**
 * Get the first fallback element matching a valid target, checking both namespaces.
 * Kept for backward compatibility — prefer getAllFallbackElements for multi-fallback support.
 */
export function getFallbackElement(stanza: Element): { element: Element; namespace: string } | null {
  const all = getAllFallbackElements(stanza)
  return all.length > 0 ? all[0] : null
}

/**
 * Check if a stanza has a fallback element for the given namespace that indicates
 * the entire body is fallback text (i.e., <body/> with no start/end range).
 *
 * This is used by reactions: a <fallback for="urn:xmpp:reactions:0"><body/></fallback>
 * means the entire body exists only for legacy clients that don't support reactions.
 */
export function isEntireBodyFallback(stanza: Element, targetNamespace: string): boolean {
  const fallbacks = getAllFallbackElements(stanza)
  for (const { element, namespace } of fallbacks) {
    if (element.attrs.for !== targetNamespace) continue
    const bodyRange = element.getChild('body', namespace)
    if (!bodyRange) continue
    // <body/> with no start/end means entire body is fallback
    if (bodyRange.attrs.start === undefined && bodyRange.attrs.end === undefined) {
      return true
    }
  }
  return false
}

/**
 * XEP-0428: Process fallback indications and strip fallback text from body.
 * Supports multiple fallback elements per stanza.
 *
 * Processing order:
 *   1. Entire-body fallbacks (no range) → returns empty processedBody immediately
 *   2. Range-based fallbacks → stripped from end-to-start to preserve indices
 *
 * @param messageStanza - The message stanza containing fallback elements
 * @param body - The original message body
 * @param options - Processing options (validTargets, trimMode)
 * @param replyTo - Optional ReplyInfo to populate fallbackBody for replies
 * @returns The processed body and optional fallback body for replies
 */
export function processFallback(
  messageStanza: Element,
  body: string,
  options: FallbackProcessingOptions,
  replyTo?: { id: string; to?: string }
): FallbackProcessingResult {
  const { validTargets, trimMode = 'full' } = options

  const fallbacks = getAllFallbackElements(messageStanza)
  if (fallbacks.length === 0) {
    return { processedBody: body }
  }

  // Collect applicable ranges and check for entire-body fallbacks
  const ranges: Array<{ start: number; end: number; forNs: string }> = []
  let fallbackBody: string | undefined

  for (const { element, namespace } of fallbacks) {
    const fallbackFor = element.attrs.for
    if (!validTargets.includes(fallbackFor)) continue

    // Note: <body> inside <fallback> inherits the fallback namespace
    const bodyRange = element.getChild('body', namespace)
    if (!bodyRange) continue

    const startAttr = bodyRange.attrs.start
    const endAttr = bodyRange.attrs.end

    // <body/> with no range — entire body is fallback for this feature
    if (startAttr === undefined && endAttr === undefined) {
      return { processedBody: '' }
    }

    const start = parseInt(startAttr, 10)
    const end = parseInt(endAttr, 10)

    if (isNaN(start) || isNaN(end) || start < 0 || end <= start || end > body.length) {
      continue
    }

    // For replies, extract and save the fallback text (for when original not found)
    if (fallbackFor === NS_REPLY && replyTo) {
      const fallbackText = body.slice(start, end)
      // Parse fallback format: "> Author: message\n" - extract just the message
      const fallbackMatch = fallbackText.match(/^> [^:]+: (.+)$/m)
      fallbackBody = fallbackMatch ? fallbackMatch[1] : fallbackText.replace(/^> /, '')
    }

    ranges.push({ start, end, forNs: fallbackFor })
  }

  if (ranges.length === 0) {
    return { processedBody: body }
  }

  // Sort ranges from end to start to preserve indices when removing
  ranges.sort((a, b) => b.start - a.start)

  let processedBody = body
  for (const { start, end } of ranges) {
    processedBody = processedBody.slice(0, start) + processedBody.slice(end)
  }

  // Clean up whitespace based on trim mode
  if (trimMode === 'full') {
    processedBody = processedBody.trim()
  } else {
    processedBody = processedBody.replace(/^\n+/, '')
  }

  return { processedBody, fallbackBody }
}
