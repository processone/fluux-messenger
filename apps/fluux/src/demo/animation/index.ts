/**
 * 5-minute demo animation timeline, assembled from 6 acts.
 */

import type { DemoAnimationStep } from '@fluux/sdk'
import { act1Steps } from './act1-warmStart'
import { act2Steps } from './act2-fileTransfer'
import { act3Steps } from './act3-groupBurst'
import { act4Steps } from './act4-searchDiscovery'
import { act5Steps } from './act5-richFeatures'
import { act6Steps } from './act6-finale'

/** Build the full 5-minute animation timeline. */
export function buildDemoAnimation(): DemoAnimationStep[] {
  return [
    ...act1Steps,
    ...act2Steps,
    ...act3Steps,
    ...act4Steps,
    ...act5Steps,
    ...act6Steps,
  ]
}
