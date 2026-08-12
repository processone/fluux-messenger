import { platform } from '@/platform'
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
    if (platform().nativeDownloads) {
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
 * On Tauri, plaintext and encrypted attachments resolve through the same native
 * media cache used by inline renderers before saving. Web plaintext keeps its
 * direct URL, while web encryption resolves decrypted bytes first. Ciphertext
 * URLs are never handed to the save path. Any resolve/decrypt failure surfaces
 * as the same localized error toast `downloadFile` uses.
 *
 * Decryption happens here, on the caller's click — never eagerly on render.
 */
export async function downloadAttachment(
  attachment: Pick<FileAttachment, 'url' | 'name' | 'encryption'>,
  options?: { errorMessage?: string },
): Promise<void> {
  const filename = attachment.name ?? 'download'
  try {
    let resolvedUrl = attachment.url
    if (attachment.encryption) {
      const { resolveEncryptedMediaUrl, resolveWebEncryptedMediaUrl } = await import('./mediaCache')
      const resolve = platform().nativeDownloads ? resolveEncryptedMediaUrl : resolveWebEncryptedMediaUrl
      resolvedUrl = await resolve(attachment.url, attachment.encryption)
    } else if (platform().nativeDownloads) {
      const { resolveMediaUrl } = await import('./mediaCache')
      resolvedUrl = await resolveMediaUrl(attachment.url)
    }
    await downloadFile(resolvedUrl, filename, options)
  } catch (error) {
    console.warn('[download] Failed to resolve attachment:', error)
    useToastStore.getState().addToast('error', options?.errorMessage ?? 'Download failed')
  }
}
