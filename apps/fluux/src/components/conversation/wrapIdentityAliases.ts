import { isWrapIdentityEnrichment, sameWrapIdentity, type WrapIdentity } from '@/stores/wrappedCodeBlocksStore'
import { messageWrapIdentity } from './messageRowIdentity'

type Listed = Parameters<typeof messageWrapIdentity>[0]

/**
 * The enrichments of one conversation's resident list that are provably the same occurrence: the
 * store replaced messages by their archive/origin-enriched selves in the same slots of a list that
 * kept its length. Every changed slot must be validated, wrapped or not: it must keep its
 * identity or gain ids (an enrichment). One slot that turns into a different message (a shift, a
 * trim, a replacement such as [A, X] to [B, Y], an arrival) means slot position proves nothing,
 * so the whole list yields no pair and the choices are left unmatched rather than transferred.
 *
 * The cost follows what changed: unchanged slots (same object) are skipped.
 */
export function inPlaceEnrichments(
  previous: readonly Listed[],
  next: readonly Listed[],
  wantedIds: ReadonlySet<string>,
): Array<[from: WrapIdentity, to: WrapIdentity]> {
  if (previous.length !== next.length) return []
  const pairs: Array<[WrapIdentity, WrapIdentity]> = []
  for (let i = 0; i < next.length; i++) {
    const before = previous[i]
    const after = next[i]
    if (before === after) continue
    const from = messageWrapIdentity(before)
    const to = messageWrapIdentity(after)
    if (!from || !to) return []
    if (sameWrapIdentity(from, to)) continue
    if (!isWrapIdentityEnrichment(from, to)) return []
    if (wantedIds.has(from.id)) pairs.push([from, to])
  }
  return pairs
}
