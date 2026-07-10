/**
 * MUC nickname hygiene and display helpers.
 *
 * Some MUC services (notably ejabberd) permit occupant nicks with leading /
 * trailing whitespace and invisible characters. This enables impersonation: an
 * attacker joins as `"admin "` (trailing space) or with zero-width / bidi
 * control characters and, reusing a trusted user's avatar, whispers a victim
 * while appearing to be that user. HTML collapses edge whitespace on render, so
 * the padded nick looks identical to the real one.
 *
 * - {@link stripNickWhitespace} normalizes our OWN outgoing nick (join / `/nick`)
 *   so we never become the impersonator and never send a padded presence.
 * - {@link splitNickForDisplay} lets the app REVEAL padding on remote nicks
 *   (never mutate them — that would complete the impersonation and break
 *   whisper addressing, which is keyed on the exact nick).
 */

import { getLocalPart } from './jid'

// Invisible / zero-width / bidi-control / soft-hyphen characters that have no
// legitimate place in a nick. Single source of truth shared by strip + reveal.
// (JS \s already covers NBSP, U+2000–200A, U+3000, U+FEFF, etc., so those are
// handled by the edge-trim; this class targets the non-\s invisibles.)
const INVISIBLE_SOURCE =
  '­​-‏‪-‮⁠-⁤⁦-⁯﻿'
// `g` for replace-all; a separate non-global regex for stateless `.test()`.
const INVISIBLE_STRIP = new RegExp(`[${INVISIBLE_SOURCE}]`, 'g')
const INVISIBLE_TEST = new RegExp(`[${INVISIBLE_SOURCE}]`)

const EDGE_WHITESPACE = /^\s+|\s+$/gu

/**
 * Normalize our own nick before it goes on the wire: remove invisible /
 * bidi-control characters anywhere, then trim Unicode edge whitespace. Internal
 * spaces are preserved (a legitimate nick may contain them). Returns `''` for an
 * all-whitespace / all-invisible input; callers decide how to handle empty.
 */
export function stripNickWhitespace(nick: string): string {
  return nick.replace(INVISIBLE_STRIP, '').replace(EDGE_WHITESPACE, '')
}

/**
 * Resolve the default MUC nickname for the local user.
 *
 * Single source of truth for "what nick do we join a room under when the user
 * hasn't typed one." Prefers the profile username (XEP-0172 PEP nickname), then
 * falls back to the bare-JID local part. The result is whitespace/invisible-char
 * hardened via {@link stripNickWhitespace} so it is safe to put on the wire.
 *
 * @param ownNickname - The user's XEP-0172 nickname (from the connection store), or null.
 * @param jid - The user's own JID (bare or full); used for the local-part fallback.
 * @returns A non-empty nick when either input is usable, otherwise `''`.
 */
export function resolveDefaultMucNick(
  ownNickname: string | null | undefined,
  jid: string | null | undefined
): string {
  const fromNick = ownNickname ? stripNickWhitespace(ownNickname) : ''
  if (fromNick) return fromNick
  const fromJid = jid ? stripNickWhitespace(getLocalPart(jid)) : ''
  return fromJid
}

export interface NickDisplay {
  /** Leading edge-whitespace run (may be ''). */
  leading: string
  /** Middle of the nick; internal spaces preserved as-is. */
  core: string
  /** Trailing edge-whitespace run (may be ''). */
  trailing: string
  /** True if the nick contains any invisible / bidi-control character. */
  hasHiddenChars: boolean
}

/**
 * Split a remote nick into edge-whitespace runs + core so the UI can reveal the
 * padding (render the edges as visible gaps) without mutating the nick. Also
 * reports whether the nick hides invisible characters (which whitespace-reveal
 * can't show — the UI badges those separately).
 */
export function splitNickForDisplay(nick: string): NickDisplay {
  const leading = nick.match(/^\s+/u)?.[0] ?? ''
  const trailing = nick.match(/\s+$/u)?.[0] ?? ''
  // Clamp so an all-whitespace nick doesn't count its run as both edges.
  const trailingStart = Math.max(leading.length, nick.length - trailing.length)
  return {
    leading,
    core: nick.slice(leading.length, trailingStart),
    trailing: nick.slice(trailingStart),
    hasHiddenChars: INVISIBLE_TEST.test(nick),
  }
}
