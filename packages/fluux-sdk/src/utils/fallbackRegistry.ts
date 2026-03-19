/**
 * XEP-0428 Fallback Feature Registry
 *
 * Central definition of which fallback namespaces this client understands
 * and should strip from message bodies.
 *
 * SAFETY RULE: Only add a namespace here if the client actually renders
 * that feature natively. Unknown fallback bodies MUST be preserved so
 * legacy clients can still display them.
 *
 * ORDERING: {@link processFallback} handles priority internally:
 *   1. Entire-body fallbacks (no range) are processed first → empty string
 *   2. Range-based fallbacks are applied end-to-start to preserve indices
 *
 * @module fallbackRegistry
 * @internal
 */

import { NS_REPLY, NS_OOB, NS_CORRECTION, NS_POLL } from '../core/namespaces'

/**
 * Base features supported in all message contexts (1:1 chat and MUC room).
 */
const BASE_FALLBACK_TARGETS = [NS_REPLY, NS_OOB, NS_CORRECTION] as const

/**
 * Additional features supported only in MUC room context.
 * Polls only exist in groupchat — stripping poll fallback in 1:1 chat would be wrong.
 */
const ROOM_ONLY_FALLBACK_TARGETS = [NS_POLL] as const

/** Fallback targets for 1:1 chat messages. */
export const CHAT_FALLBACK_TARGETS: string[] = [...BASE_FALLBACK_TARGETS]

/** Fallback targets for MUC room messages (superset of chat targets). */
export const ROOM_FALLBACK_TARGETS: string[] = [...BASE_FALLBACK_TARGETS, ...ROOM_ONLY_FALLBACK_TARGETS]
