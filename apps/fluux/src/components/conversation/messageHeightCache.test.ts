import { describe, it, expect, beforeEach } from 'vitest'
import { heightCacheKey, getCachedHeights, recordMeasuredHeight, __clearHeightCache } from './messageHeightCache'

beforeEach(() => __clearHeightCache())

describe('messageHeightCache', () => {
  it('keys by message id + width bucket + scale', () => {
    expect(heightCacheKey('m1', 560, 100)).toBe('m1@560@100')
    expect(heightCacheKey('m1', 560, 125)).not.toBe(heightCacheKey('m1', 560, 100))
  })
  it('records and reads back a measured height per conversation', () => {
    recordMeasuredHeight('conv1', heightCacheKey('m1', 560, 100), 84)
    expect(getCachedHeights('conv1').get('m1@560@100')).toBe(84)
    expect(getCachedHeights('conv2').get('m1@560@100')).toBeUndefined()
  })
  it('does not record zero or negative heights', () => {
    recordMeasuredHeight('conv1', heightCacheKey('m1', 560, 100), 0)
    recordMeasuredHeight('conv1', heightCacheKey('m2', 560, 100), -5)
    expect(getCachedHeights('conv1').get('m1@560@100')).toBeUndefined()
    expect(getCachedHeights('conv1').get('m2@560@100')).toBeUndefined()
  })
  it('evicts the oldest conversation when LRU limit is exceeded', () => {
    for (let i = 0; i < 8; i++) {
      recordMeasuredHeight(`conv${i}`, heightCacheKey('m1', 560, 100), 40 + i)
    }
    // All 8 conversations exist
    expect(getCachedHeights('conv0').get('m1@560@100')).toBe(40)
    // Adding a 9th (conv8) should evict the LRU entry. conv0 was accessed last by getCachedHeights
    // above, so conv1 is now LRU.
    recordMeasuredHeight('conv8', heightCacheKey('m1', 560, 100), 48)
    expect(getCachedHeights('conv8').get('m1@560@100')).toBe(48)
    expect(getCachedHeights('conv1').get('m1@560@100')).toBeUndefined()
  })
})
