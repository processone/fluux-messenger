/**
 * The iOS side of photo reduction: `share-inbox` plugin commands that read and
 * re-encode a photo with Image I/O. A photo is named by an import or staging
 * id; the plugin resolves its confined directory, never a path from here.
 */
import { invoke } from '@tauri-apps/api/core'
import type { EncodedPhoto, PhotoProbe, PhotoSource } from './photoReduction'

type PhotoRef = { kind: 'share' | 'staged'; id: string }

function nativeSource(ref: PhotoRef): PhotoSource {
  return {
    probe: () => invoke<PhotoProbe>('plugin:share-inbox|probe_photo', { source: ref }),
    encode: (attempt, { maxSide, quality }) =>
      invoke<EncodedPhoto>('plugin:share-inbox|encode_photo', { source: ref, attempt, maxSide, quality }),
    read: attempt => invoke<ArrayBuffer>('plugin:share-inbox|read_photo', { source: ref, attempt }),
  }
}

export interface NativePhoto {
  source: PhotoSource
  /** Removes native copies once the chosen bytes are in memory. Imports are removed with the import. */
  done(): Promise<void>
}

/** A photo imported by the share extension, read in place: its original is not loaded. */
export function sharedPhoto(id: string): NativePhoto {
  return { source: nativeSource({ kind: 'share', id }), done: async () => {} }
}

/** Copies a picked or pasted photo for native decoding, as the raw request body. */
export async function stagePhoto(file: File): Promise<NativePhoto> {
  const id = crypto.randomUUID()
  await invoke('plugin:share-inbox|stage_photo', new Uint8Array(await file.arrayBuffer()), { headers: { 'x-photo-id': id } })
  return {
    source: nativeSource({ kind: 'staged', id }),
    done: () => invoke('plugin:share-inbox|discard_photo', { id }),
  }
}
