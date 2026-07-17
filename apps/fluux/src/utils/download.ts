import { isTauri } from './tauri'
import { useToastStore } from '@/stores/toastStore'
import type { FileAttachment } from '@fluux/sdk'

/**
 * Download a file from a URL.
 * In Tauri, uses the native save dialog + fs plugin because the webview
 * ignores the <a download> attribute and navigates to the URL instead.
 *
 * Failures are surfaced as an error toast rather than silently swallowed: the
 * fs plugin only permits writes under `$HOME`, so saving elsewhere rejects
 * `writeFile`, and the proxied fetch can fail or return a non-OK status. A
 * user-cancelled save dialog is NOT a failure. Pass `errorMessage` (an i18n'd
 * string) so the toast is localized; callers fire this without awaiting.
 */
export async function downloadFile(
  url: string,
  filename: string,
  options?: { errorMessage?: string },
): Promise<void> {
  try {
    if (isTauri()) {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const { writeFile } = await import('@tauri-apps/plugin-fs')

      const savePath = await save({ defaultPath: filename })
      if (!savePath) return // user cancelled — not a failure

      const response = await fetch(url)
      if (!response.ok) {
        // Don't write a 404/500 error page out as the "downloaded" file.
        throw new Error(`fetch failed: HTTP ${response.status}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      await writeFile(savePath, bytes)
    } else {
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }
  } catch (error) {
    console.warn('[download] Failed to save file:', error)
    useToastStore.getState().addToast('error', options?.errorMessage ?? 'Download failed')
  }
}

/**
 * Download an attachment, decrypting first when it is XEP-0454 (aesgcm)
 * ciphertext. Type-agnostic: keys solely on `attachment.encryption`.
 *
 * For a plaintext attachment this is exactly `downloadFile(url, name)`. For an
 * encrypted one it resolves the DECRYPTED bytes through the same cached
 * media-cache resolver the inline renderers use (so a file already viewed
 * inline is a cache hit), then saves those bytes. The ciphertext URL is never
 * handed to the save path. Any resolve/decrypt failure (AEAD auth-tag mismatch,
 * fetch error) surfaces as the same localized error toast `downloadFile` uses.
 *
 * Decryption happens here, on the caller's click — never eagerly on render.
 */
export async function downloadAttachment(
  attachment: Pick<FileAttachment, 'url' | 'name' | 'encryption'>,
  options?: { errorMessage?: string },
): Promise<void> {
  const filename = attachment.name ?? 'download'
  if (!attachment.encryption) {
    await downloadFile(attachment.url, filename, options)
    return
  }
  try {
    const { resolveEncryptedMediaUrl, resolveWebEncryptedMediaUrl } = await import('./mediaCache')
    const resolve = isTauri() ? resolveEncryptedMediaUrl : resolveWebEncryptedMediaUrl
    const decryptedUrl = await resolve(attachment.url, attachment.encryption)
    await downloadFile(decryptedUrl, filename, options)
  } catch (error) {
    console.warn('[download] Failed to decrypt attachment:', error)
    useToastStore.getState().addToast('error', options?.errorMessage ?? 'Download failed')
  }
}
