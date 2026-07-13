import type { ComponentType } from 'react'
import { ChristmasAnimation } from './ChristmasAnimation'
import { FireworksAnimation } from './FireworksAnimation'

/**
 * Wire animation name → overlay component. Adding a new easter egg means one
 * entry here plus a command in `commands/registry.ts` — the views stay
 * untouched.
 */
const ANIMATIONS: Record<string, ComponentType<{ onComplete: () => void }>> = {
  christmas: ChristmasAnimation,
  fireworks: FireworksAnimation,
}

interface EasterEggAnimationProps {
  animation: string
  onComplete: () => void
}

/** Full-screen easter-egg overlay dispatcher. Unknown names (e.g. eggs from newer clients) render nothing. */
export function EasterEggAnimation({ animation, onComplete }: EasterEggAnimationProps) {
  // `animation` is wire-controlled (any contact/occupant can send it): only accept the map's own
  // properties, so prototype-chain keys like '__proto__'/'constructor'/'toString' never resolve.
  const Overlay = Object.hasOwn(ANIMATIONS, animation) ? ANIMATIONS[animation] : undefined
  if (!Overlay) return null
  return <Overlay onComplete={onComplete} />
}
