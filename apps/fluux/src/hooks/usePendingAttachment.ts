import { useCallback, useEffect, useRef, useState } from 'react'
import { platform } from '@/platform'
import { fitsUpload, preparePhoto, reduciblePhotoType, type PreparedPhoto } from '@/utils/photoReduction'
import { sharedPhoto, stagePhoto, type NativePhoto } from '@/utils/nativePhoto'
import type { ShareInbox, SharedItem } from '@/utils/shareInbox'

/** A large photo Fluux may reduce before sending (iOS, FLM-22). */
export interface PendingPhoto {
  /** The photo as received from the picker, the clipboard or the share extension; never modified. */
  name: string
  size: number
  /** Displayed dimensions of the received photo, once read. */
  width?: number
  height?: number
  status: 'preparing' | 'failed' | 'ready'
  /** Which representation Send uploads once ready. */
  mode: 'reduced' | 'original'
  /** The reduced copy, offered only when it saves enough and fits the server. */
  reduced?: { file: File; width: number; height: number }
  /** Why a prepared photo has no reduced copy to offer. */
  unchanged?: 'no-gain' | 'too-large'
  /** The server's size limit when the photo was prepared. */
  limit?: number
}

/** Pending attachment staged for sending (not yet sent) */
export interface PendingAttachment {
  /** What Send uploads. */
  file: File
  previewUrl?: string
  photo?: PendingPhoto
  // Note: attachment field is NOT included here - files are only uploaded when user clicks Send
  // This prevents accidental file uploads from drag-and-drop mistakes (privacy protection)
}

/** Send waits while a photo is prepared, after a failure until the user chooses, and while it is too large. */
export function photoBlocksSend(attachment: PendingAttachment | null | undefined, encrypted: boolean): boolean {
  const photo = attachment?.photo
  if (!photo) return false
  return photo.status !== 'ready' || !fitsUpload(attachment.file.size, photo.limit, encrypted)
}

/**
 * The attachment staged in a composer, including the reduction of a large photo.
 *
 * Preparation, a change of representation, removal and cancellation stay on
 * the device: nothing is uploaded before Send. Off iOS a file is staged as it is.
 */
export function usePendingAttachment(limit: number | undefined) {
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null)
  const latest = useRef(pendingAttachment)
  latest.current = pendingAttachment
  const session = useRef({ generation: 0, urls: [] as string[], original: undefined as (() => Promise<File>) | undefined })
  const limitRef = useRef(limit)
  limitRef.current = limit

  /** Ends the current attachment; results of its preparation that arrive later are ignored. */
  const release = useCallback(() => {
    for (const url of session.current.urls) URL.revokeObjectURL(url)
    session.current = { generation: session.current.generation + 1, urls: [], original: undefined }
    return session.current.generation
  }, [])
  useEffect(() => () => { release() }, [release])

  const preview = useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    session.current.urls.push(url)
    return url
  }, [])

  const clear = useCallback(() => {
    release()
    setPendingAttachment(null)
  }, [release])

  const prepare = useCallback(async (
    generation: number,
    received: File,
    open: () => Promise<NativePhoto>,
    original: () => Promise<File>,
    size = received.size,
  ) => {
    const live = () => session.current.generation === generation
    session.current.original = original
    const base = { name: received.name, size, limit: limitRef.current }
    // The received photo is not previewed: only its reduced copy is decoded at full size.
    setPendingAttachment({ file: received, photo: { ...base, status: 'preparing', mode: 'reduced' } })
    let prepared: PreparedPhoto
    try {
      const native = await open()
      try {
        prepared = await preparePhoto(received.name, size, native.source, base.limit)
      } finally {
        void native.done().catch(() => {})
      }
    } catch {
      // The original is never substituted silently: the user keeps it or removes the photo.
      if (live()) setPendingAttachment({ file: received, photo: { ...base, status: 'failed', mode: 'original' } })
      return
    }
    if (!live()) return
    if (prepared.kind === 'reduced') {
      const reduced = { file: prepared.file, ...prepared.reduced }
      setPendingAttachment({
        file: prepared.file,
        previewUrl: preview(prepared.file),
        photo: { ...base, ...prepared.source, status: 'ready', mode: 'reduced', reduced },
      })
      return
    }
    let file: File
    try {
      file = await original()
    } catch (error) {
      if (live()) setPendingAttachment(null)
      throw error
    }
    if (!live()) return
    setPendingAttachment({
      file,
      previewUrl: preview(file),
      photo: prepared.kind === 'skip' ? undefined : { ...base, ...prepared.source, status: 'ready', mode: 'original', unchanged: prepared.reason },
    })
  }, [preview])

  /** Stages a picked, pasted or dropped file. */
  const stage = useCallback((file: File) => {
    const generation = release()
    if (!platform().reducesLargePhotos || !reduciblePhotoType(file)) {
      const media = file.type.startsWith('image/') || file.type.startsWith('video/')
      setPendingAttachment({ file, previewUrl: media ? preview(file) : undefined })
      return
    }
    void prepare(generation, file, () => stagePhoto(file), async () => file)
  }, [release, preview, prepare])

  /**
   * Stages an import of the share extension. A photo is prepared from the
   * import in place, so only the representation chosen is read into memory.
   * Rejects when the import's file cannot be read.
   */
  const stageShared = useCallback(async (item: SharedItem, api: ShareInbox) => {
    const generation = release()
    setPendingAttachment(null)
    // An import carries the type the extension read, which the plugin's reader checks against the file.
    if (item.name === null || !platform().reducesLargePhotos || !reduciblePhotoType({ name: '', type: item.mime ?? '' })) {
      const file = await api.file(item)
      if (file && session.current.generation === generation) {
        setPendingAttachment({ file, previewUrl: file.type.startsWith('image/') ? preview(file) : undefined })
      }
      return
    }
    const received = new File([], item.name, { type: item.mime ?? '' })
    const original = async () => {
      const file = await api.file(item)
      if (!file) throw new Error('Missing shared file')
      return file
    }
    await prepare(generation, received, async () => sharedPhoto(item.id), original, item.size)
  }, [release, preview, prepare])

  /** Switches between the reduced copy and the original, or keeps the original after a failure. */
  const choosePhoto = useCallback(async (mode: 'reduced' | 'original') => {
    const current = latest.current
    const photo = current?.photo
    if (!current || !photo || photo.status === 'preparing' || (photo.status === 'ready' && photo.mode === mode)) return
    if (mode === 'reduced') {
      if (photo.reduced) setPendingAttachment({ ...current, file: photo.reduced.file, photo: { ...photo, mode } })
      return
    }
    const load = session.current.original
    if (!load) return
    const generation = session.current.generation
    setPendingAttachment({ ...current, photo: { ...photo, status: 'preparing', mode } })
    try {
      const file = await load()
      if (session.current.generation !== generation) return
      session.current.original = async () => file
      setPendingAttachment({ ...current, file, photo: { ...photo, status: 'ready', mode } })
    } catch (error) {
      if (session.current.generation === generation) setPendingAttachment(current)
      throw error
    }
  }, [])

  return { pendingAttachment, stage, stageShared, choosePhoto, clear }
}
