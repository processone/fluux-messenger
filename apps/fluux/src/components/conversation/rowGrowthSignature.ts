/**
 * Signature of everything that can change a RESIDENT row's height IN PLACE.
 *
 * Rows normally change height by appearing (a new message) — the new-message effect handles that.
 * But several payloads land on a message that is ALREADY rendered, growing its row without touching
 * the message count or the last-message id:
 *
 *   - reactions (XEP-0444)          — adds/removes the reactions strip
 *   - link previews (XEP-0422/OGP)  — a fastening that arrives seconds later, after the OGP fetch
 *   - attachments                   — a fastening, or a decrypted-on-download media swap
 *   - corrections (XEP-0308)        — a new body re-wraps to a different number of lines
 *   - retractions                   — the body collapses into a tombstone
 *
 * While the reader is sticked to the bottom, that growth must be absorbed ABOVE (previous messages
 * scroll up) instead of shoving the newest message below the fold. Nothing else can see it: under
 * virtualization the content ResizeObserver is deliberately disabled (it feeds back into the
 * @tanstack spacer churn), and the media components either never notify (LinkPreviewCard has a fixed
 * aspect box) or notify only when a bitmap decodes. So this signature IS the trigger — see the
 * row-growth effect in useMessageListScroll.
 *
 * Cheap by construction: a message contributes only when it actually carries one of these, so the
 * common plain-text row costs a bare iteration.
 */

export interface RowGrowthMessage {
  id: string
  body?: string
  reactions?: Record<string, string[]>
  attachment?: unknown
  linkPreview?: unknown
  isEdited?: boolean
  isRetracted?: boolean
}

/**
 * djb2 over the body, as unsigned base-36. Keeps the signature a fixed few chars per edited row
 * instead of embedding whole message bodies (this string is rebuilt and compared every render).
 * A hash collision costs one missed re-pin, which the next stimulus corrects — the previous
 * length-only fingerprint collided on every same-length rewrap instead.
 */
function hashBody(body: string): string {
  let hash = 5381
  for (let i = 0; i < body.length; i += 1) {
    hash = (((hash << 5) + hash) ^ body.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

export function computeRowGrowthSignature(messages: readonly RowGrowthMessage[]): string {
  let sig = ''
  for (const m of messages) {
    const reactions = m.reactions
    const hasReactions = reactions !== undefined && Object.keys(reactions).length > 0
    if (
      !hasReactions &&
      m.linkPreview == null &&
      m.attachment == null &&
      !m.isEdited &&
      !m.isRetracted
    ) {
      continue
    }
    sig += m.id
    if (hasReactions) sig += `r${JSON.stringify(reactions)}`
    if (m.linkPreview != null) sig += 'l'
    if (m.attachment != null) sig += 'a'
    // A correction replaces the body, and `isEdited` stays true across successive corrections, so
    // the body itself has to be fingerprinted. Length alone is not enough: bodies render with
    // `whitespace-pre-wrap` in proportional text, so two same-length bodies can be different
    // heights — `aaaaa` is one line, `a\na\na` is three.
    if (m.isEdited) sig += `e${hashBody(m.body ?? '')}`
    if (m.isRetracted) sig += 'x'
    sig += ';'
  }
  return sig
}
