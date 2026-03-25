/**
 * Types for the demo tutorial tooltip system.
 */

/** How to detect that the user has completed a tutorial action. */
export type CompletionTrigger =
  | { type: 'click'; selector: string }
  | { type: 'navigate'; hash: string }
  | { type: 'dom-appears'; selector: string }
  | { type: 'timeout'; ms: number }
  | { type: 'manual' }

/** A single tutorial step shown as a floating tooltip. */
export interface TutorialStep {
  /** Unique identifier, referenced from animation data. */
  id: string
  /** CSS selector for the target element to point at. */
  targetSelector: string
  /** Main tooltip text. */
  content: string
  /** Bold call-to-action line (e.g., "Try clicking the image"). */
  actionHint?: string
  /** Position relative to target. */
  position: 'top' | 'bottom' | 'left' | 'right'
  /** How to detect the user completed the action. */
  completionTrigger: CompletionTrigger
  /** Max wait before auto-skipping (prevents stuck state). Default: 30000ms. */
  maxWaitMs?: number
}
