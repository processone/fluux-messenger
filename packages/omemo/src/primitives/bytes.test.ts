import { describe, it, expect } from 'vitest'
import { concatBytes, bytesEqual, u32be } from './bytes'

describe('bytes helpers', () => {
  it('concatBytes joins in order', () => {
    expect(concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]))).toEqual(new Uint8Array([1, 2, 3]))
  })
  it('bytesEqual is true for equal, false for different length or content', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
  })
  it('u32be encodes big-endian', () => {
    expect(u32be(0x01020304)).toEqual(new Uint8Array([1, 2, 3, 4]))
  })
  it('concatBytes with zero arrays returns empty array', () => {
    expect(concatBytes()).toEqual(new Uint8Array([]))
  })
  it('concatBytes with empty arrays interleaved returns non-empty result unaffected', () => {
    expect(concatBytes(new Uint8Array([]), new Uint8Array([1]), new Uint8Array([]))).toEqual(new Uint8Array([1]))
  })
  it('bytesEqual is true for two empty arrays', () => {
    expect(bytesEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true)
  })
  it('bytesEqual is false for equal-length different-content arrays', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toBe(false)
  })
  it('u32be encodes 0', () => {
    expect(u32be(0)).toEqual(new Uint8Array([0, 0, 0, 0]))
  })
  it('u32be encodes 0xffffffff', () => {
    expect(u32be(0xffffffff)).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]))
  })
})
