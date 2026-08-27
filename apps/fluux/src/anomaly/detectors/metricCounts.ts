/**
 * The single translation point from a metric name to a registry constant.
 *
 * Mirrors `signalRecords.ts`: the seam carries a closed string union because it may
 * not import `values.ts`, and this is where that union becomes provenance-carrying
 * constants. Typed as a total `Record`, so a name added to the union without a
 * constant here is a COMPILE error rather than a counter that silently vanishes.
 *
 * @module Anomaly/Detectors/MetricCounts
 */
import type { AnomalyMetricName } from '../../utils/anomalyMetric'
import { METRIC, type Opaque } from '../values'

const METRICS: Readonly<Record<AnomalyMetricName, Opaque>> = Object.freeze({
  'render.MessageList': METRIC.renderMessageList,
  'scroll.writes': METRIC.scrollWrites,
  'scroll.positioningOps': METRIC.scrollPositioningOps,
})

/** The constant for a metric name, or null if the name is not one we mint. */
export function metricConstant(name: AnomalyMetricName): Opaque | null {
  // `Object.hasOwn`, not a truthiness check: a name matching an Object.prototype
  // member would otherwise resolve to an inherited function and be counted.
  return Object.hasOwn(METRICS, name) ? METRICS[name] : null
}
