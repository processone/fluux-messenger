import { describe, expect, it, vi } from 'vitest'
import {
  ATTEMPTS, REDUCE_ABOVE_BYTES, REDUCE_ABOVE_SIDE, chooseReduction, needsReduction, preparePhoto, reduciblePhotoType,
  type EncodedPhoto, type PhotoProbe, type PhotoSource,
} from './photoReduction'

// Intent: the photo reduction the captain accepted in FLM-22 (direction A, iOS first).
//
// Readings of real public photos from Wikimedia Commons, measured with the
// production PhotoPreparation.swift (Image I/O, Xcode 27.1 on macOS):
// - Fronalpstock_big.jpg, a 10109 x 4542 landscape;
// - Kapooka_Military_Area_Monument.jpg, an iPhone 14 Pro portrait with location;
// - Domino's_Pizza_Lamp.jpg, an already small iPhone 15 Pro photo;
// - a 1920 x 1080 PNG screenshot of Fluux.
const photos = {
  landscape: {
    size: 14_679_474,
    probe: { type: 'public.jpeg', width: 10109, height: 4542, reducible: true },
    attempts: [{ width: 2560, height: 1150, size: 1_007_172 }, { width: 2048, height: 920, size: 542_696 }, { width: 1600, height: 719, size: 325_589 }],
  },
  portrait: {
    size: 6_321_555,
    probe: { type: 'public.jpeg', width: 3024, height: 4032, reducible: true },
    attempts: [{ width: 1920, height: 2560, size: 3_039_681 }, { width: 1536, height: 2048, size: 1_815_718 }, { width: 1200, height: 1600, size: 1_014_303 }],
  },
  small: {
    size: 695_917,
    probe: { type: 'public.jpeg', width: 1918, height: 1918, reducible: true },
    attempts: [{ width: 1918, height: 1918, size: 1_150_923 }, { width: 1918, height: 1918, size: 971_033 }, { width: 1600, height: 1600, size: 767_186 }],
  },
  screenshot: {
    size: 1_088_261,
    probe: { type: 'public.png', width: 1920, height: 1080, reducible: false },
    attempts: [],
  },
} satisfies Record<string, { size: number; probe: PhotoProbe; attempts: EncodedPhoto[] }>

function native(photo: (typeof photos)[keyof typeof photos]) {
  const source = {
    probe: vi.fn(async () => photo.probe),
    encode: vi.fn(async (attempt: number) => photo.attempts[attempt]),
    read: vi.fn(async (attempt: number) => new ArrayBuffer(photo.attempts[attempt].size)),
  } satisfies PhotoSource
  return source
}

describe('when a photo is reduced', () => {
  it('reduces photos above 4 MiB or 4096 pixels, but not at the thresholds', () => {
    const { probe } = photos.portrait
    expect(needsReduction(photos.portrait.size, probe, undefined)).toBe(true)
    expect(needsReduction(photos.landscape.size, photos.landscape.probe, undefined)).toBe(true)
    expect(needsReduction(REDUCE_ABOVE_BYTES, { ...probe, width: REDUCE_ABOVE_SIDE, height: 3072 }, undefined)).toBe(false)
    expect(needsReduction(REDUCE_ABOVE_BYTES + 1, { ...probe, width: REDUCE_ABOVE_SIDE, height: 3072 }, undefined)).toBe(true)
    expect(needsReduction(REDUCE_ABOVE_BYTES, { ...probe, width: REDUCE_ABOVE_SIDE + 1, height: 3072 }, undefined)).toBe(true)
    expect(needsReduction(photos.small.size, photos.small.probe, undefined)).toBe(false)
  })

  it('reduces a small photo the server would refuse, counting the encryption tag', () => {
    expect(needsReduction(photos.small.size, photos.small.probe, photos.small.size + 16)).toBe(false)
    expect(needsReduction(photos.small.size, photos.small.probe, photos.small.size + 15)).toBe(true)
  })

  it('never reduces other image types', () => {
    expect(needsReduction(photos.screenshot.size, photos.screenshot.probe, 1)).toBe(false)
    expect(reduciblePhotoType({ name: 'screenshot.png', type: 'image/png' })).toBeNull()
    expect(reduciblePhotoType({ name: 'IMG_0001.HEIC', type: '' })).toBe('image/heic')
    expect(reduciblePhotoType({ name: 'IMG_0001.jpg', type: 'application/octet-stream' })).toBe('image/jpeg')
    expect(reduciblePhotoType({ name: 'IMG_0001.jpg', type: 'image/jpeg' })).toBe('image/jpeg')
  })
})

describe('which copy is kept', () => {
  it('keeps the first attempt at or under 2 MiB, without trying the others', async () => {
    const source = native(photos.landscape)
    expect(await chooseReduction(photos.landscape.size, undefined, source.encode))
      .toEqual({ kind: 'reduced', attempt: 0, photo: photos.landscape.attempts[0] })
    expect(source.encode).toHaveBeenCalledOnce()
    expect(source.encode).toHaveBeenCalledWith(0, ATTEMPTS[0])
  })

  it('tries the next definition from the source when the first copy is above 2 MiB', async () => {
    const source = native(photos.portrait)
    expect(await chooseReduction(photos.portrait.size, undefined, source.encode))
      .toEqual({ kind: 'reduced', attempt: 1, photo: photos.portrait.attempts[1] })
    expect(source.encode.mock.calls).toEqual([[0, ATTEMPTS[0]], [1, ATTEMPTS[1]]])
  })

  it('keeps the original when no attempt saves 10%', async () => {
    const limit = 600_000
    expect(needsReduction(photos.small.size, photos.small.probe, limit)).toBe(true)
    expect(await chooseReduction(photos.small.size, limit, native(photos.small).encode))
      .toEqual({ kind: 'unchanged', reason: 'no-gain' })
  })

  it('offers no copy when every useful one is still above the server limit', async () => {
    expect(await chooseReduction(photos.portrait.size, 900_000, native(photos.portrait).encode))
      .toEqual({ kind: 'unchanged', reason: 'too-large' })
    expect(await chooseReduction(photos.portrait.size, 1_100_000, native(photos.portrait).encode))
      .toEqual({ kind: 'reduced', attempt: 2, photo: photos.portrait.attempts[2] })
  })
})

describe('preparing a photo', () => {
  it('returns the chosen copy as a JPEG named after the source', async () => {
    const source = native(photos.portrait)
    const prepared = await preparePhoto('IMG_4032.HEIC', photos.portrait.size, source, undefined)
    expect(prepared).toMatchObject({ kind: 'reduced', source: { width: 3024, height: 4032 }, reduced: { width: 1536, height: 2048 } })
    if (prepared.kind !== 'reduced') return
    expect(prepared.file.name).toBe('IMG_4032.jpg')
    expect(prepared.file.type).toBe('image/jpeg')
    expect(prepared.file.size).toBe(photos.portrait.attempts[1].size)
    expect(source.read).toHaveBeenCalledWith(1)
  })

  it('leaves photos under the thresholds and other types untouched, without encoding', async () => {
    for (const photo of [photos.small, photos.screenshot]) {
      const source = native(photo)
      expect(await preparePhoto('photo', photo.size, source, undefined)).toEqual({ kind: 'skip' })
      expect(source.encode).not.toHaveBeenCalled()
    }
  })

  it('fails rather than sending an incomplete copy', async () => {
    const source = native(photos.landscape)
    source.read.mockResolvedValue(new ArrayBuffer(1000))
    await expect(preparePhoto('Fronalpstock_big.jpg', photos.landscape.size, source, undefined)).rejects.toThrow()
  })
})
