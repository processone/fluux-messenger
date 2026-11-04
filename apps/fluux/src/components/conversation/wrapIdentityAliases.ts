import { isWrapIdentityEnrichment, sameWrapIdentity, type WrapIdentity } from '@/stores/wrappedCodeBlocksStore'
import { messageWrapIdentity } from './messageRowIdentity'

type Listed = Parameters<typeof messageWrapIdentity>[0]

/**
 * The enrichments of one conversation's resident list that are provably the same occurrence: the
 * store replaced a message by its archive/origin-enriched self in the same slot of a list that
 * kept its length and every other slot's identity. Any other change that touches a message with a
 * stored wrap choice (a shift, a trim, an arrival, a look-alike in the slot) proves nothing, so
 * the whole list yields no pair and the choice is left to be dropped rather than transferred.
 *
 * Only messages whose id has a stored choice are examined (`wantedIds`), and only slots whose
 * object changed, so the cost follows what changed, not the list size.
 */
export function inPlaceEnrichments(
  previous: readonly Listed[],
  next: readonly Listed[],
  wantedIds: ReadonlySet<string>,
): Array<[from: WrapIdentity, to: WrapIdentity]> {
  const touchesChoice = (message: Listed | undefined) => !!message?.id && wantedIds.has(message.id)
  const pairs: Array<[WrapIdentity, WrapIdentity]> = []
  const sameShape = previous.length === next.length
  const length = Math.max(previous.length, next.length)
  for (let i = 0; i < length; i++) {
    const before = previous[i]
    const after = next[i]
    if (before === after || (!touchesChoice(before) && !touchesChoice(after))) continue
    if (!sameShape || !before || !after) return []
    const from = messageWrapIdentity(before)
    const to = messageWrapIdentity(after)
    if (!from || !to) return []
    if (sameWrapIdentity(from, to)) continue
    if (!isWrapIdentityEnrichment(from, to)) return []
    pairs.push([from, to])
  }
  return pairs
}
