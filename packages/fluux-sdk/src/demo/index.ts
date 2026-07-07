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

// Resident-window dev/test seam: shrink the sliding-window bound so the
// slide / load-newer / jump-to-latest paths are exercisable with a small
// backlog (the demo gates the setter behind a `?window=` URL param). Not on
// the product API — SDK internals read it via a relative import.
export { getResidentWindowSize, setResidentWindowSize } from '../stores/shared/residentWindow'
