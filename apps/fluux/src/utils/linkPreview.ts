/**
 * Link preview utilities for fetching URL metadata
 * Uses Tauri command to bypass CORS and fetch Open Graph metadata
 */

// Note: invoke is imported dynamically inside functions to avoid loading Tauri APIs in web mode
import { isTauri } from './tauri'

export interface UrlMetadata {
  url: string
  title: string | null
  description: string | null
  image: string | null
  site_name: string | null
}

/**
 * Fetch metadata from a URL using the Tauri backend
 * Returns null if not running in Tauri or if fetch fails
 */
export async function fetchUrlMetadata(url: string): Promise<UrlMetadata | null> {
  if (!isTauri()) {
    console.warn('Link preview is only available in the desktop app')
    return null
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<UrlMetadata>('fetch_url_metadata', { url })
    return result
  } catch (error) {
    console.error('Failed to fetch URL metadata:', error)
    return null
  }
}

/**
 * Extract the first URL from a message body
 * Returns null if no URL is found
 */
export function extractFirstUrl(text: string): string | null {
  // Match http:// or https:// URLs
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi
  const match = text.match(urlPattern)
  return match ? match[0] : null
}

/**
 * Check if a URL is likely to be an image (skip link preview for these)
 */
export function isImageUrl(url: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']
  const urlLower = url.toLowerCase()
  return imageExtensions.some(ext => urlLower.includes(ext))
}
