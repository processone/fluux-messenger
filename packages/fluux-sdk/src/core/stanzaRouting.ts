/**
 * Declarative stanza routing.
 *
 * Each module states the stanza SHAPES it may handle. The router matches an
 * incoming stanza against those claims and offers it to the matching modules
 * most-specific first; the first one whose `handle()` returns true consumes it.
 *
 * `handle()` is still the decider, because some claims cannot be expressed
 * statically — MUC only wants an error presence when it has a join or nick
 * change in flight for that room. A claim narrows the candidates and fixes the
 * order; it does not promise to consume.
 *
 * Specificity derives the order rather than a hand-written module array:
 * a claim naming a child element outranks one naming only a stanza type, which
 * outranks a bare kind. Two modules claiming the SAME shape is the one case
 * specificity cannot settle, so it is a declared conflict — see
 * {@link findAmbiguousClaims}, which the routing test asserts is empty.
 *
 * @module Core/StanzaRouting
 */
import type { Element } from '@xmpp/client'

/** A stanza shape a module may handle. */
export interface StanzaClaim {
  kind: 'message' | 'presence' | 'iq'
  /** Only stanzas carrying this child element match. */
  child?: { name: string; ns?: string }
  /**
   * Only stanzas with this `type` attribute match. `null` matches a stanza with
   * no `type` at all, which is how available presence is expressed.
   */
  type?: string | null
  /**
   * Tie-break for two claims of equal specificity. Higher is offered first.
   * Needed only for a genuine overlap; {@link findAmbiguousClaims} reports any
   * overlap left undeclared.
   */
  priority?: number
}

/** A module that participates in routing. */
export interface StanzaClaimant {
  readonly claims: readonly StanzaClaim[]
  /** Return true to consume the stanza and stop the walk. */
  handle(stanza: Element): boolean | void
}

/**
 * A module that sees stanzas but never consumes them.
 *
 * Kept separate from claimants because an observer must not depend on whether
 * some other module happened to claim first. An observer that sits at the end
 * of a consume-chain silently stops running the moment anything ahead of it
 * widens its claim.
 */
export interface StanzaObserver {
  readonly observes: readonly StanzaClaim[]
  observe(stanza: Element): void
}

/** Does this stanza have the shape the claim describes? */
export function claimMatches(claim: StanzaClaim, stanza: Element): boolean {
  if (!stanza.is(claim.kind)) return false
  if (claim.type !== undefined) {
    const type = stanza.attrs.type
    if (claim.type === null ? type !== undefined && type !== '' : type !== claim.type) return false
  }
  if (claim.child && !stanza.getChild(claim.child.name, claim.child.ns)) return false
  return true
}

/**
 * How narrowly a claim describes a stanza. Higher wins, so a module asking for
 * one child element is offered the stanza before one asking for a whole kind.
 */
export function claimSpecificity(claim: StanzaClaim): number {
  return (claim.child ? 2 : 0) + (claim.type !== undefined ? 1 : 0)
}

interface Candidate<T> {
  claimant: T
  specificity: number
  priority: number
}

/**
 * The claimants that want this stanza, most specific first. Stable within a
 * (specificity, priority) tier, so declaration order remains the last resort
 * rather than the primary mechanism.
 */
export function selectClaimants<T extends StanzaClaimant>(stanza: Element, claimants: readonly T[]): T[] {
  const candidates: Candidate<T>[] = []
  for (const claimant of claimants) {
    let best: Candidate<T> | null = null
    for (const claim of claimant.claims) {
      if (!claimMatches(claim, stanza)) continue
      const specificity = claimSpecificity(claim)
      const priority = claim.priority ?? 0
      // A module may hold several claims; it is offered the stanza once, at its
      // strongest matching claim.
      if (!best || specificity > best.specificity || (specificity === best.specificity && priority > best.priority)) {
        best = { claimant, specificity, priority }
      }
    }
    if (best) candidates.push(best)
  }
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) =>
      b.candidate.specificity - a.candidate.specificity ||
      b.candidate.priority - a.candidate.priority ||
      a.index - b.index)
    .map(({ candidate }) => candidate.claimant)
}

/**
 * Offer the stanza to every matching claimant until one consumes it, then run
 * every matching observer regardless of the outcome.
 *
 * Observers are firewalled from each other and from the stanza loop: they run
 * for every matching stanza, so a throw in one would otherwise stop the others
 * and escape into the transport's stanza handler. Claimants are deliberately
 * NOT firewalled — a module that fails while consuming a stanza is a real
 * error, and swallowing it would hide a broken feature behind a silent drop.
 */
export function routeStanza(
  stanza: Element,
  claimants: readonly StanzaClaimant[],
  observers: readonly StanzaObserver[] = [],
): void {
  for (const claimant of selectClaimants(stanza, claimants)) {
    if (claimant.handle(stanza)) break
  }
  for (const observer of observers) {
    if (!observer.observes.some((claim) => claimMatches(claim, stanza))) continue
    try {
      observer.observe(stanza)
    } catch {
      // See above: an observer never affects routing, failure included.
    }
  }
}

/** A pair of claims that describe the same shape without saying who goes first. */
export interface AmbiguousClaim {
  a: string
  b: string
  claim: StanzaClaim
}

/**
 * Overlaps that specificity cannot settle: two claimants naming the same shape
 * at the same specificity and the same priority. Whichever is declared first
 * would win, which is exactly the implicit ordering this module exists to
 * remove, so the routing test requires this to be empty.
 *
 * Claims of DIFFERENT specificity are not reported: that is the mechanism
 * working, and it is what lets Chat claim every message while PubSub takes the
 * ones carrying an event payload.
 */
export function findAmbiguousClaims(
  claimants: readonly { name: string; claims: readonly StanzaClaim[] }[],
): AmbiguousClaim[] {
  const found: AmbiguousClaim[] = []
  for (let i = 0; i < claimants.length; i++) {
    for (let j = i + 1; j < claimants.length; j++) {
      for (const a of claimants[i].claims) {
        for (const b of claimants[j].claims) {
          if (!sameShape(a, b)) continue
          if ((a.priority ?? 0) !== (b.priority ?? 0)) continue
          found.push({ a: claimants[i].name, b: claimants[j].name, claim: a })
        }
      }
    }
  }
  return found
}

function sameShape(a: StanzaClaim, b: StanzaClaim): boolean {
  return a.kind === b.kind
    && a.type === b.type
    && a.child?.name === b.child?.name
    && a.child?.ns === b.child?.ns
}
