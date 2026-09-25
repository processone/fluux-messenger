import { invoke } from '@tauri-apps/api/core'
import type { FileAttachment } from '@fluux/sdk'

export interface SharedItem {
  id: string
  text: string
  name: string | null
  mime: string | null
  size: number
}
export interface ShareInbox {
  list(): Promise<SharedItem[]>
  file(item: SharedItem): Promise<File | undefined>
  remove(id: string): Promise<void>
}

export const nativeShareInbox: ShareInbox = {
  list: () => invoke('plugin:share-inbox|list'),
  async file(item) {
    if (item.name === null) return undefined
    const parts: Uint8Array<ArrayBuffer>[] = []
    let offset = 0
    while (offset < item.size) {
      const encoded = await invoke<string>('plugin:share-inbox|read', { id: item.id, offset })
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
      if (!bytes.length || offset + bytes.length > item.size) throw new Error('Incomplete shared file')
      parts.push(bytes)
      offset += bytes.length
    }
    return new File(parts, item.name, { type: item.mime || 'application/octet-stream' })
  },
  remove: id => invoke('plugin:share-inbox|remove', { id }),
}

interface ShareDelivery {
  check: () => void
  upload: (file: File) => Promise<FileAttachment | null>
  send: (body: string, attachment?: FileAttachment) => Promise<unknown>
  sent: () => void
  remove: () => Promise<void>
}

/** Import and preview never call this: delivery requires an explicit Send. */
export async function deliverShare(text: string, file: File | undefined, delivery: ShareDelivery): Promise<void> {
  delivery.check()
  const attachment = file ? await delivery.upload(file) : undefined
  if (file && !attachment) throw new Error('Upload failed')
  delivery.check()
  await delivery.send(text.trim() || attachment?.url || '', attachment ?? undefined)
  // A cleanup failure must not re-enable Send and duplicate an accepted message.
  delivery.sent()
  await delivery.remove()
}
