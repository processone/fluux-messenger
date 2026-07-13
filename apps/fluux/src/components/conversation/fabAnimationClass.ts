/**
 * Compute the animation/visibility class for the scroll-to-bottom FAB.
 *
 * The FAB div is always mounted; its visibility is driven purely by CSS animations whose
 * `forwards` fill holds the end state. On a fresh conversation open at the bottom the FAB is
 * hidden and must stay hidden WITHOUT playing the exit animation — otherwise the `fab-spring-out`
 * keyframe (which starts at opacity:1, fully visible) paints the FAB on frame 0 and springs it
 * away, producing a visible flash on every open (MessageList is remounted per conversation via
 * `key`, so a plain mount replays the animation).
 *
 * So the exit animation only runs once the FAB has actually been shown at least once. Before that,
 * a static hidden state (`opacity-0`) keeps it invisible with no animation.
 */
export function fabAnimationClass(fabVisible: boolean, hasBeenVisible: boolean): string {
  if (fabVisible) {
    return 'animate-[fab-spring-in_0.4s_var(--fluux-ease-spring)_forwards]'
  }
  if (hasBeenVisible) {
    return 'animate-[fab-spring-out_0.25s_ease-in_forwards] pointer-events-none'
  }
  return 'opacity-0 pointer-events-none'
}
