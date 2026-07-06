/**
 * # Fluux SDK — Demo Mode
 *
 * Dev-only demo client and seed helpers. Import from `@fluux/sdk/demo`.
 * Intentionally kept off the main `@fluux/sdk` entry so it is tree-shaken
 * out of production app bundles.
 *
 * @packageDocumentation
 * @module Demo
 */

export { DemoClient } from './DemoClient'
export type {
  DemoData,
  DemoSelf,
  DemoPresence,
  DemoOwnResource,
  DemoRoomData,
  DemoAnimationStep,
} from './types'
export type { StressScenario } from './stress'
export { minutesAgo, hoursAgo, daysAgo } from './timeHelpers'
