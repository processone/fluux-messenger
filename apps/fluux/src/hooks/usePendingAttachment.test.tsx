import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { sharedPhoto, stagePhoto, type NativePhoto } from '@/utils/nativePhoto'
import type { ShareInbox } from '@/utils/shareInbox'
import { photoBlocksSend, usePendingAttachment } from './usePendingAttachment'

vi.mock('@/utils/nativePhoto', () => ({ stagePhoto: vi.fn(), sharedPhoto: vi.fn() }))

// Intent: the reduction the captain accepted in FLM-22, on iOS only: preparation
// stays local, Send waits for it, and the original is never substituted silently.
//
// Image I/O readings of Kapooka_Military_Area_Monument.jpg, a real iPhone 14 Pro
// portrait from Wikimedia Commons (see photoReduction.test.ts).
const portrait = {
  size: 6_321_555,
  probe: { type: 'public.jpeg', width: 3024, height: 4032, reducible: true },
  attempts: [{ width: 1920, height: 2560, size: 3_039_681 }, { width: 1536, height: 2048, size: 1_815_718 }, { width: 1200, height: 1600, size: 1_014_303 }],
}

function photoNative(fail = false): NativePhoto & { done: ReturnType<typeof vi.fn> } {
  return {
    source: {
      probe: async () => { if (fail) throw new Error('Unreadable photo'); return portrait.probe },
      encode: async attempt => portrait.attempts[attempt],
      read: async attempt => new ArrayBuffer(portrait.attempts[attempt].size),
    },
    done: vi.fn(async () => {}),
  }
}

const received = () => new File([new ArrayBuffer(portrait.size)], 'IMG_0001.JPG', { type: 'image/jpeg' })
let restore: () => void
let urls = 0
beforeEach(() => {
  restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
  vi.mocked(stagePhoto).mockReset()
  vi.mocked(sharedPhoto).mockReset()
  URL.createObjectURL = vi.fn(() => `blob:preview-${++urls}`)
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => restore())

describe('a large photo picked or pasted on iOS', () => {
  it('is reduced locally, previews only the copy, and can be switched to the original', async () => {
    const native = photoNative()
    vi.mocked(stagePhoto).mockResolvedValue(native)
    const original = received()
    const { result } = renderHook(() => usePendingAttachment(undefined))
    act(() => result.current.stage(original))
    expect(result.current.pendingAttachment).toMatchObject({ photo: { status: 'preparing' } })
    expect(result.current.pendingAttachment?.previewUrl).toBeUndefined()
    expect(photoBlocksSend(result.current.pendingAttachment, false)).toBe(true)

    await waitFor(() => expect(result.current.pendingAttachment?.photo?.status).toBe('ready'))
    const reduced = result.current.pendingAttachment!
    expect(reduced.file.name).toBe('IMG_0001.jpg')
    expect(reduced.file.size).toBe(portrait.attempts[1].size)
    expect(reduced.photo).toMatchObject({ mode: 'reduced', size: portrait.size, width: 3024, height: 4032, reduced: { width: 1536, height: 2048 } })
    expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(reduced.file)
    expect(native.done).toHaveBeenCalledOnce()
    expect(photoBlocksSend(reduced, true)).toBe(false)

    await act(() => result.current.choosePhoto('original'))
    expect(result.current.pendingAttachment?.file).toBe(original)
    expect(result.current.pendingAttachment?.photo?.mode).toBe('original')
    expect(result.current.pendingAttachment?.previewUrl).toBe(reduced.previewUrl)
    await act(() => result.current.choosePhoto('reduced'))
    expect(result.current.pendingAttachment?.file).toBe(reduced.file)
  })

  it('waits for an explicit choice when the photo cannot be reduced', async () => {
    vi.mocked(stagePhoto).mockResolvedValue(photoNative(true))
    const original = received()
    const { result } = renderHook(() => usePendingAttachment(undefined))
    act(() => result.current.stage(original))
    await waitFor(() => expect(result.current.pendingAttachment?.photo?.status).toBe('failed'))
    expect(photoBlocksSend(result.current.pendingAttachment, false)).toBe(true)
    await act(() => result.current.choosePhoto('original'))
    expect(result.current.pendingAttachment).toMatchObject({ file: original, photo: { status: 'ready', mode: 'original' } })
    expect(result.current.pendingAttachment?.photo?.reduced).toBeUndefined()
    expect(photoBlocksSend(result.current.pendingAttachment, false)).toBe(false)
  })

  it('blocks Send when not even a reduced copy fits the server', async () => {
    vi.mocked(stagePhoto).mockResolvedValue(photoNative())
    const { result } = renderHook(() => usePendingAttachment(900_000))
    act(() => result.current.stage(received()))
    await waitFor(() => expect(result.current.pendingAttachment?.photo?.status).toBe('ready'))
    expect(result.current.pendingAttachment?.photo).toMatchObject({ mode: 'original', unchanged: 'too-large', limit: 900_000 })
    expect(photoBlocksSend(result.current.pendingAttachment, false)).toBe(true)
  })

  it('drops a preparation that finishes after the photo was removed, and its native copy', async () => {
    let finish!: (native: NativePhoto) => void
    vi.mocked(stagePhoto).mockReturnValue(new Promise(resolve => { finish = resolve }))
    const { result } = renderHook(() => usePendingAttachment(undefined))
    act(() => result.current.stage(received()))
    act(() => result.current.clear())
    const native = photoNative()
    await act(async () => finish(native))
    await waitFor(() => expect(native.done).toHaveBeenCalledOnce())
    expect(result.current.pendingAttachment).toBeNull()
  })

  it('stages files as before on other platforms', () => {
    restore()
    restore = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    const original = received()
    const { result } = renderHook(() => usePendingAttachment(undefined))
    act(() => result.current.stage(original))
    expect(result.current.pendingAttachment).toEqual({ file: original, previewUrl: 'blob:preview-' + urls })
    expect(stagePhoto).not.toHaveBeenCalled()
  })
})

describe('a large photo shared to Fluux on iOS', () => {
  it('is prepared in place and its original is read only once chosen', async () => {
    vi.mocked(sharedPhoto).mockReturnValue(photoNative())
    const original = received()
    const api: ShareInbox = { list: vi.fn(), remove: vi.fn(), file: vi.fn(async () => original) }
    const item = { id: '12345678-1234-1234-1234-123456789abc', text: '', name: 'IMG_0001.JPG', mime: 'image/jpeg', size: portrait.size }
    const { result } = renderHook(() => usePendingAttachment(undefined))
    await act(() => result.current.stageShared(item, api))
    expect(sharedPhoto).toHaveBeenCalledWith(item.id)
    expect(api.file).not.toHaveBeenCalled()
    expect(result.current.pendingAttachment?.file.size).toBe(portrait.attempts[1].size)
    await act(() => result.current.choosePhoto('original'))
    await act(() => result.current.choosePhoto('reduced'))
    await act(() => result.current.choosePhoto('original'))
    expect(api.file).toHaveBeenCalledOnce()
    expect(result.current.pendingAttachment?.file).toBe(original)
  })
})
