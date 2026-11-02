/**
 * Utility for preparing avatar images for notifications.
 *
 * Tauri notifications require file:// URLs for attachments. See
 * {@link getNotificationAvatarUrl} for conversion and caching.
 */

import { platform } from '@/platform'

// Cache of hash -> file path to avoid rewriting same avatars
const avatarFileCache = new Map<string, string>()

/**
 * Get avatar URL suitable for notifications.
 * - For Tauri: writes the avatar image to a temp file, returns file:// URL
 * - For Web: returns the avatar URL directly (works as icon)
 *
 * @param blobUrl - The avatar URL to display
 * @param hash - Avatar hash for desktop file reuse; iOS attachments need independent files.
 * @returns URL suitable for notification icon/attachment, or undefined if unavailable
 */
export async function getNotificationAvatarUrl(
  blobUrl: string | undefined,
  hash?: string
): Promise<string | undefined> {
  if (!blobUrl) return undefined

  const capabilities = platform()
  if (!capabilities.notificationsNeedFileUrls) {
    return blobUrl
  }

  // iOS moves an attachment into its own storage. A cached or shared path can
  // lose a later notification, so each iOS preparation must own a fresh file.
  const reusableHash = capabilities.os === 'ios' ? undefined : hash
  if (reusableHash && avatarFileCache.has(reusableHash)) {
    return avatarFileCache.get(reusableHash)
  }

  try {
    // Dynamic import to avoid issues when not in Tauri
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    const { tempDir, join } = await import('@tauri-apps/api/path')

    const response = await fetch(blobUrl)
    const blob = await response.blob()
    const arrayBuffer = await blob.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    // Determine file extension from mime type
    const ext = getExtensionFromMimeType(blob.type)

    // Desktop pictures may be reused; consumable iOS attachments must not collide.
    const filename = reusableHash
      ? `avatar-${reusableHash}.${ext}`
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

    if (reusableHash) {
      avatarFileCache.set(reusableHash, fileUrl)
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
