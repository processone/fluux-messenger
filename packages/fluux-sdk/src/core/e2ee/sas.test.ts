import { describe, expect, it } from 'vitest'
import { deriveSas, splitSas } from './sas'

const FP_A = 'A1B2C3D4E5F60718293A4B5C6D7E8F9001020304'
const FP_B = 'F0E1D2C3B4A5968778695A4B3C2D1E0FFEDCBA98'
const FP_C = '11223344556677889900AABBCCDDEEFF11223344'

describe('deriveSas', () => {
  it('is symmetric in its arguments', async () => {
    const ab = await deriveSas(FP_A, FP_B)
    const ba = await deriveSas(FP_B, FP_A)
    expect(ab).toEqual(ba)
  })

  it('is deterministic', async () => {
    const x1 = await deriveSas(FP_A, FP_B)
    const x2 = await deriveSas(FP_A, FP_B)
    expect(x1).toEqual(x2)
  })

  it('returns two 4-digit zero-padded strings', async () => {
    const { firstHalf, secondHalf } = await deriveSas(FP_A, FP_B)
    expect(firstHalf).toMatch(/^\d{4}$/)
    expect(secondHalf).toMatch(/^\d{4}$/)
  })

  it('changes when one of the fingerprints changes', async () => {
    const ab = await deriveSas(FP_A, FP_B)
    const ac = await deriveSas(FP_A, FP_C)
    // We accept that the two halves could in theory both collide, but
    // for chosen distinct inputs the chance is vanishingly small. Assert
    // the joined 8-digit string differs.
    const join = (s: { firstHalf: string; secondHalf: string }) => s.firstHalf + s.secondHalf
    expect(join(ab)).not.toEqual(join(ac))
  })

  it('is insensitive to case and embedded separators', async () => {
    const canonical = await deriveSas(FP_A, FP_B)
    const noisy = await deriveSas(
      FP_A.toLowerCase().replace(/(.{4})/g, '$1 ').trim(),
      FP_B.toLowerCase().replace(/(.{4})/g, '$1:').replace(/:$/, ''),
    )
    expect(canonical).toEqual(noisy)
  })

  it('separates the two inputs to avoid concatenation collisions', async () => {
    // Without a separator, ("abcd","ef") and ("abc","def") would hash
    // the same string. The `:` between sorted halves prevents that.
    const x = await deriveSas('abcd', 'ef')
    const y = await deriveSas('abc', 'def')
    const join = (s: { firstHalf: string; secondHalf: string }) => s.firstHalf + s.secondHalf
    expect(join(x)).not.toEqual(join(y))
  })

  it('zero-pads the leading half when the digit count is short', async () => {
    // We can't easily construct an input that produces a leading-zero
    // half, but we can confirm the format contract holds for many random
    // inputs — at least one will have a leading-zero half over 1000 tries
    // (1-in-10 per half by uniform distribution).
    const tries = await Promise.all(
      Array.from({ length: 200 }, (_, i) => deriveSas(`fp${i}a`, `fp${i}b`)),
    )
    for (const { firstHalf, secondHalf } of tries) {
      expect(firstHalf.length).toBe(4)
      expect(secondHalf.length).toBe(4)
    }
  })
})

describe('splitSas', () => {
  const sas = { firstHalf: '1234', secondHalf: '5678' }

  it("assigns firstHalf to the lex-first JID's owner", () => {
    const aliceView = splitSas('alice@example.com', 'bob@example.com', sas)
    expect(aliceView).toEqual({ mine: '1234', theirs: '5678' })
  })

  it("assigns secondHalf to the lex-second JID's owner", () => {
    const bobView = splitSas('bob@example.com', 'alice@example.com', sas)
    expect(bobView).toEqual({ mine: '5678', theirs: '1234' })
  })

  it("each side's `mine` equals the other side's `theirs`", () => {
    const aliceView = splitSas('alice@example.com', 'bob@example.com', sas)
    const bobView = splitSas('bob@example.com', 'alice@example.com', sas)
    expect(aliceView.mine).toBe(bobView.theirs)
    expect(aliceView.theirs).toBe(bobView.mine)
  })

  it('is insensitive to JID case', () => {
    const lower = splitSas('alice@example.com', 'bob@example.com', sas)
    const mixed = splitSas('Alice@Example.com', 'BOB@example.com', sas)
    expect(lower).toEqual(mixed)
  })

  it('strips the resource so bare and full JIDs split identically', () => {
    const bare = splitSas('alice@example.com', 'bob@example.com', sas)
    const full = splitSas('alice@example.com/laptop', 'bob@example.com', sas)
    expect(bare).toEqual(full)
  })
})
