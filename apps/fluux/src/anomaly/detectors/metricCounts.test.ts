// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAnomalyMetricHandler,
  countAnomalyMetric,
  setAnomalyMetricHandler,
  type AnomalyMetricName,
} from '../../utils/anomalyMetric'
import { metricConstant } from './metricCounts'
import { initTokenizer, isKind, resetValuesForTesting } from '../values'

/**
 * Every member of the seam's union, written out.
 *
 * A loop over `Object.keys` of the map under test would pass by construction — it
 * would only prove the map agrees with itself. This list is the independent copy
 * that makes the assertion mean something, and adding a name to the union without
 * adding it here leaves it uncovered rather than silently green.
 */
const EVERY_NAME: AnomalyMetricName[] = [
  'render.MessageList',
  'scroll.writes',
  'scroll.positioningOps',
]

beforeEach(async () => {
  localStorage.clear()
  resetValuesForTesting()
  clearAnomalyMetricHandler()
  await initTokenizer()
})

describe('metric names become registry constants', () => {
  it('maps every name the seam can carry', () => {
    for (const name of EVERY_NAME) {
      const constant = metricConstant(name)
      expect(constant, `${name} has no constant`).not.toBeNull()
      // A counter, specifically. A constant of any other category would be refused
      // by `count()` at the far end and the metric would vanish.
      expect(isKind(constant, 'counter'), `${name} is not a counter`).toBe(true)
    }
  })

  it('refuses a name it does not mint rather than counting a free string', () => {
    expect(metricConstant('made.up' as AnomalyMetricName)).toBeNull()
    // An inherited member must not resolve to a function off Object.prototype.
    expect(metricConstant('toString' as AnomalyMetricName)).toBeNull()
    expect(metricConstant('constructor' as AnomalyMetricName)).toBeNull()
  })
})

describe('the counting seam', () => {
  it('is inert with no handler, which is every release build', () => {
    expect(() => countAnomalyMetric('render.MessageList')).not.toThrow()
  })

  it('routes the name and the increment to the handler', () => {
    const seen: Array<[string, number]> = []
    setAnomalyMetricHandler((name, by) => seen.push([name, by]))
    countAnomalyMetric('scroll.writes')
    countAnomalyMetric('scroll.writes', 4)
    expect(seen).toEqual([
      ['scroll.writes', 1],
      ['scroll.writes', 4],
    ])
  })

  it('swallows a handler fault, because these call sites are a render and a frame loop', () => {
    setAnomalyMetricHandler(() => {
      throw new Error('recorder exploded')
    })
    expect(() => countAnomalyMetric('render.MessageList')).not.toThrow()
  })
})
