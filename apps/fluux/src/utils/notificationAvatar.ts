/**
 * Utility for preparing avatar images for desktop notifications.
 *
 * Tauri notifications require file:// URLs for attachments, while
 * avatars are stored as blob URLs in memory. This utility converts
 * blob URLs to temp files for Tauri, with caching to avoid rewrites.
 */

import { isTauri } from './tauri'

// Cache of hash -> file path to avoid rewriting same avatars
const avatarFileCache = new Map<string, string>()

/**
 * Get avatar URL suitable for notifications.
 * - For Tauri: converts blob URL to temp file, returns file:// URL
 * - For Web: returns blob URL directly (works as icon)
 *
 * @param blobUrl - The avatar blob URL (e.g., 'blob:http://...')
 * @param hash - Avatar hash for caching (optional but recommended)
 * @returns URL suitable for notification icon/attachment, or undefined if unavailable
 */
export async function getNotificationAvatarUrl(
  blobUrl: string | undefined,
  hash?: string
): Promise<string | undefined> {
  if (!blobUrl) return undefined

  // Web notifications can use blob URLs directly
  if (!isTauri()) {
    return blobUrl
  }

  // Check cache first if hash provided
  if (hash && avatarFileCache.has(hash)) {
    return avatarFileCache.get(hash)
  }

  try {
    // Dynamic import to avoid issues when not in Tauri
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    const { tempDir, join } = await import('@tauri-apps/api/path')

    // Fetch blob data from blob URL
    const response = await fetch(blobUrl)
    const blob = await response.blob()
    const arrayBuffer = await blob.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    // Determine file extension from mime type
    const ext = getExtensionFromMimeType(blob.type)

    // Generate filename (use hash if available, otherwise random)
    const filename = hash
      ? `avatar-${hash}.${ext}`
      : `avatar-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

    // Write to temp directory (use join for cross-platform path handling)
    const tempPath = await tempDir()
    const filePath = await join(tempPath, filename)

    await writeFile(filePath, data)

    // Convert to file:// URL (cross-platform)
    // Windows: file:///C:/path, Unix: file:///path
    const normalizedPath = filePath.replace(/\\/g, '/')
    const fileUrl = normalizedPath.startsWith('/')
      ? `file://${normalizedPath}`
      : `file:///${normalizedPath}` // Windows paths need extra slash

    // Cache if hash provided
    if (hash) {
      avatarFileCache.set(hash, fileUrl)
    }

    return fileUrl
  } catch (error) {
    console.warn('[NotificationAvatar] Failed to create avatar file:', error)
    return undefined
  }
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  }
  return mimeToExt[mimeType] || 'png'
}

/**
 * Clear cached avatar file paths.
 * Call this on logout or when avatars might have changed.
 */
export function clearAvatarFileCache(): void {
  avatarFileCache.clear()
}
