/**
 * Native download transport for the desktop app.
 *
 * Invokes the Rust `download_file` command and receives the response bytes
 * as Tauri's RAW IPC body. Do NOT route large downloads through
 * `@tauri-apps/plugin-http`: its `fetch_read_body` loop returns every
 * response chunk as a plain number array through JSON invoke, blocking the
 * WebView main thread ~20ms per MB (the `[MainThreadStall]` class — same
 * problem the upload side fixed via `upload_file`/`tauriUpload.ts`). The raw
 * body is a single memcpy.
 *
 * Metadata travels in invoke headers, mirroring the upload transport. When
 * `decrypt` is set, the AES-256-GCM key/IV go over base64-encoded and Rust
 * returns the decrypted plaintext (XEP-0454), so ciphertext never needs a
 * second pass through the WebView.
 *
 * A raw IPC response carries no headers, so Rust prefixes the body with a
 * small envelope — `[4-byte LE meta length][meta JSON][file bytes]` — that
 * {@link parseDownloadEnvelope} splits back apart (the JSON carries the
 * response Content-Type).
 */

import type { FileEncryption } from '@fluux/sdk'

const PROGRESS_EVENT = 'fluux://download-progress'

interface ProgressPayload {
  id: string
  received: number
  total: number
}

export interface TauriDownloadParams {
  url: string
  /** AES-256-GCM params — decrypt in Rust before returning (XEP-0454). */
  decrypt?: Pick<FileEncryption, 'key' | 'iv'>
  onProgress?: (percent: number) => void
}

export interface TauriDownloadResult {
  /** File bytes — already decrypted when `decrypt` was passed. */
  bytes: Uint8Array
  /** Response Content-Type with any parameters (e.g. charset) stripped. */
  contentType: string | null
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Split the raw IPC envelope from `download_file` into metadata + bytes. */
export function parseDownloadEnvelope(data: ArrayBuffer): TauriDownloadResult {
  if (data.byteLength < 4) {
    throw new Error('download_file returned a malformed envelope (too short)')
  }
  const metaLength = new DataView(data).getUint32(0, true)
  if (4 + metaLength > data.byteLength) {
    throw new Error('download_file returned a malformed envelope (bad meta length)')
  }
  const meta = JSON.parse(
    new TextDecoder().decode(new Uint8Array(data, 4, metaLength)),
  ) as { contentType: string | null }
  const contentType = meta.contentType?.split(';')[0].trim() || null
  return {
    bytes: new Uint8Array(data, 4 + metaLength),
    contentType,
  }
}

/**
 * GET a file via the native `download_file` command, optionally decrypting
 * it in Rust. Returns the (plaintext) bytes plus the response Content-Type.
 */
export async function downloadFileTauri(params: TauriDownloadParams): Promise<TauriDownloadResult> {
  // Dynamic imports keep Tauri APIs out of the web bundle (same pattern as
  // the rest of the app's Tauri integrations).
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ])

  const downloadId = crypto.randomUUID()
  const { onProgress } = params
  const unlisten = onProgress
    ? await listen<ProgressPayload>(PROGRESS_EVENT, (event) => {
        if (event.payload.id !== downloadId) return
        const { received, total } = event.payload
        onProgress(total > 0 ? Math.round((received / total) * 100) : 100)
      })
    : null

  try {
    const headers: Record<string, string> = {
      'x-get-url': params.url,
      'x-download-id': downloadId,
    }
    if (params.decrypt) {
      headers['x-decrypt-key'] = bytesToBase64(params.decrypt.key)
      headers['x-decrypt-iv'] = bytesToBase64(params.decrypt.iv)
    }
    const data = await invoke<ArrayBuffer>('download_file', undefined, { headers })
    return parseDownloadEnvelope(data)
  } finally {
    unlisten?.()
  }
}
