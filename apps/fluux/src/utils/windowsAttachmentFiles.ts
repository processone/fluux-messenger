import type { FileAttachment } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'

/**
 * Windows document attachments live in Downloads. Explicit saves always create
 * a new copy; opening reuses a local copy only if its attachment identity matches.
 * Keep the original owner records for compatibility with previous releases.
 */
const pendingByFilename = new Map<string, Promise<void>>()
const knownOwners = new Map<string, string>()
const storagePrefix = 'fluux:attachment-download-owner:v1:'
const savedCopyPrefix = 'fluux:attachment-download-copy:v1:'

function safeFilename(name: string | undefined): string {
  const leaf = (name || 'attachment').replace(/\\/g, '/').split('/').pop() || 'attachment'
  let cleaned = leaf.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 160).replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned || 'attachment'
}

function isSafeSavedCopy(name: string): boolean {
  // Numbered copies may be longer than the sanitized original filename.
  return !!name && !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
}

function ownerStorageKey(filename: string): string {
  return `${storagePrefix}${filename.toLowerCase()}`
}

function getSavedOwner(filename: string): string | null {
  const key = ownerStorageKey(filename)
  try {
    return localStorage.getItem(key) ?? knownOwners.get(key) ?? null
  } catch {
    return knownOwners.get(key) ?? null
  }
}

function rememberSavedOwner(filename: string, owner: string): void {
  const key = ownerStorageKey(filename)
  knownOwners.set(key, owner)
  try {
    localStorage.setItem(key, owner)
  } catch {
    // The current session still remembers the association if storage is blocked.
  }
}

function savedCopyKey(filename: string, owner: string): string {
  return `${savedCopyPrefix}${filename.toLowerCase()}:${owner}`
}

function getSavedCopy(filename: string, owner: string): string | null {
  const key = savedCopyKey(filename, owner)
  try {
    return localStorage.getItem(key) ?? knownOwners.get(key) ?? null
  } catch {
    return knownOwners.get(key) ?? null
  }
}

function rememberSavedCopy(filename: string, owner: string, copy: string): void {
  rememberSavedOwner(copy, owner)
  const key = savedCopyKey(filename, owner)
  knownOwners.set(key, copy)
  try {
    localStorage.setItem(key, copy)
  } catch {
    // The current session still remembers the association if storage is blocked.
  }
}

function numberedFilename(filename: string, number: number): string {
  if (number === 0) return filename
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  return `${stem} (${number})${extension}`
}

async function sourceIdentity(attachment: FileAttachment): Promise<string> {
  // Do not store media URLs or encryption metadata as plain text in localStorage.
  const data = new TextEncoder().encode(`${attachment.url}\u0000${JSON.stringify(attachment.encryption ?? null)}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map(v => v.toString(16).padStart(2, '0'))
    .join('')
}

async function resolveAttachmentUrl(attachment: FileAttachment): Promise<string> {
  const { resolveEncryptedMediaUrl, resolveMediaUrl } = await import('./mediaCache')
  if (attachment.encryption) return resolveEncryptedMediaUrl(attachment.url, attachment.encryption)
  return resolveMediaUrl(attachment.url)
}

async function saveOrOpen(attachment: FileAttachment, mode: 'save' | 'open', filename: string): Promise<void> {
  const { downloadDir, join } = await import('@tauri-apps/api/path')
  const { exists, writeFile, remove } = await import('@tauri-apps/plugin-fs')
  const dir = await downloadDir()
  const owner = await sourceIdentity(attachment)

  if (mode === 'open') {
    // Prefer the last successfully saved copy, falling back to the original
    // filename used by older versions. Never open an unrelated same-named file.
    const savedCopy = getSavedCopy(filename, owner)
    for (const candidate of new Set([savedCopy, filename])) {
      if (!candidate || !isSafeSavedCopy(candidate) || getSavedOwner(candidate) !== owner) continue
      const path = await join(dir, candidate)
      if (await exists(path)) {
        const { openPath } = await import('@tauri-apps/plugin-opener')
        await openPath(path)
        return
      }
    }
  }

  // Finish downloading/decrypting before creating any local file.
  const mediaUrl = await resolveAttachmentUrl(attachment)
  const response = await fetch(mediaUrl)
  if (!response.ok) throw new Error(`Unable to download attachment: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())

  for (let number = 0; ; number++) {
    const copy = numberedFilename(filename, number)
    const path = await join(dir, copy)
    if (await exists(path)) continue

    // Reserve the name exclusively: even a simultaneous download (including
    // an attachment whose original name already ends in " (1)") cannot
    // overwrite an existing file between exists() and creation.
    try {
      await writeFile(path, new Uint8Array(0), { createNew: true })
    } catch (error) {
      if (await exists(path)) continue
      throw error
    }

    try {
      await writeFile(path, bytes, { create: false })
    } catch (error) {
      await remove(path).catch(() => {})
      throw error
    }

    rememberSavedCopy(filename, owner, copy)
    if (mode === 'open') {
      const { openPath } = await import('@tauri-apps/plugin-opener')
      await openPath(path)
    }
    return
  }
}

/** Queue operations by Windows filename, preventing simultaneous name collisions. */
export async function handleWindowsAttachment(
  attachment: FileAttachment,
  mode: 'save' | 'open',
  errorMessage: string,
): Promise<void> {
  const filename = safeFilename(attachment.name)
  const key = filename.toLowerCase()
  const previous = pendingByFilename.get(key)
  const operation = (async () => {
    try {
      // One failed download must not block later attempts.
      if (previous) await previous.catch(() => {})
      await saveOrOpen(attachment, mode, filename)
    } catch (error) {
      console.error('[attachment] Windows file operation failed:', error)
      useToastStore.getState().addToast('error', errorMessage)
    }
  })()
  pendingByFilename.set(key, operation)
  try {
    await operation
  } finally {
    if (pendingByFilename.get(key) === operation) pendingByFilename.delete(key)
  }
}
