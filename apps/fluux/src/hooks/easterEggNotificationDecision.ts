export interface EasterEggContext {
  isOwn: boolean
  isActive: boolean
}

export type EasterEggDecision = { kind: 'none' } | { kind: 'notify' }

/**
 * Pure decision for a received easter egg.
 * - none    if it is our own send (already played on send)
 * - none    if the conversation is active (the store binding plays it there)
 * - notify  otherwise — toast + store a pending egg for on-open replay
 */
export function decideEasterEggNotification(ctx: EasterEggContext): EasterEggDecision {
  if (ctx.isOwn) return { kind: 'none' }
  if (ctx.isActive) return { kind: 'none' }
  return { kind: 'notify' }
}
