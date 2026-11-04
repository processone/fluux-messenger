import { isWrapIdentityEnrichment, sameWrapIdentity, type WrapIdentity } from '@/stores/wrappedCodeBlocksStore'
import { messageWrapIdentity } from './messageRowIdentity'

type WrapIdentitySource = Parameters<typeof messageWrapIdentity>[0]

/**
 * The identity changes of one conversation between two versions of its message list that are
 * archive/origin enrichments of one and the same occurrence: an identity that left the list, and
 * the one identity that appeared in its place carrying the ids it learned.
 *
 * A pair is reported only when it is unambiguous both ways. A look-alike twin that was already in
 * the previous list is not "new", so it never qualifies; two new identities that could both stand
 * for the same departed one, or one new identity that could stand for two, are left alone.
 */
export function wrapIdentityAliases(
  previous: readonly WrapIdentitySource[],
  next: readonly WrapIdentitySource[],
): Array<[from: WrapIdentity, to: WrapIdentity]> {
  const identities = (messages: readonly WrapIdentitySource[]) =>
    messages.flatMap((m) => messageWrapIdentity(m) ?? [])
  const before = identities(previous)
  const after = identities(next)
  const departed = before.filter((b) => !after.some((a) => sameWrapIdentity(a, b)))
  const arrived = after.filter((a) => !before.some((b) => sameWrapIdentity(a, b)))
  if (departed.length === 0 || arrived.length === 0) return []
  const pairs: Array<[WrapIdentity, WrapIdentity]> = []
  for (const from of departed) {
    const targets = arrived.filter((to) => isWrapIdentityEnrichment(from, to))
    if (targets.length !== 1) continue
    const [to] = targets
    if (departed.filter((d) => isWrapIdentityEnrichment(d, to)).length !== 1) continue
    pairs.push([from, to])
  }
  return pairs
}
