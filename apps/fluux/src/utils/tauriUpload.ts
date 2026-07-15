/**
 * Native upload transport for the desktop app.
 *
 * Invokes the Rust `upload_file` command with the file bytes as Tauri's RAW
 * IPC body. Do NOT route uploads through `@tauri-apps/plugin-http`: its JS
 * shim expands the body into a plain number array and JSON-serializes it,
 * blocking the WebView main thread ~20ms per MB (a ~1s freeze at 40MB —
 * the `[MainThreadStall]` class). The raw body is a single memcpy.
 *
 * Metadata travels in invoke headers because raw-body invokes carry no JSON
 * args. When `encrypt` is set, AES-256-GCM runs in Rust and the fresh
 * key/IV come back base64-encoded; this mirrors the web build, where
 * `MediaEncryption.encryptFile` (WebCrypto) produces the same
 * ciphertext-with-appended-tag shape.
 */

import type { FileEncryption } from '@fluux/sdk'

const PROGRESS_EVENT = 'fluux://upload-progress'

interface ProgressPayload {
  id: string
  sent: number
  total: number
}

interface UploadFileResponse {
  key: string | null
  iv: string | null
}

export interface TauriUploadParams {
  /** Plaintext file bytes — encryption, when requested, happens in Rust. */
  bytes: ArrayBuffer
  putUrl: string
  contentType: string
  /** Extra PUT headers from the XEP-0363 slot (e.g. Authorization). */
  headers?: Record<string, string>
  /** AES-256-GCM-encrypt in Rust before the PUT (XEP-0454). */
  encrypt: boolean
  onProgress?: (percent: number) => void
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * PUT a file to an upload slot via the native `upload_file` command.
 * Returns the encryption params when `encrypt` was requested, undefined
 * otherwise.
 */
export async function uploadFileTauri(params: TauriUploadParams): Promise<FileEncryption | undefined> {
  // Dynamic imports keep Tauri APIs out of the web bundle (same pattern as
  // the rest of the app's Tauri integrations).
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ])

  const uploadId = crypto.randomUUID()
  const { onProgress } = params
  const unlisten = onProgress
    ? await listen<ProgressPayload>(PROGRESS_EVENT, (event) => {
        if (event.payload.id !== uploadId) return
        const { sent, total } = event.payload
        onProgress(total > 0 ? Math.round((sent / total) * 100) : 100)
      })
    : null

  try {
    const result = await invoke<UploadFileResponse>('upload_file', new Uint8Array(params.bytes), {
      headers: {
        'x-put-url': params.putUrl,
        'x-content-type': params.contentType,
        'x-encrypt': params.encrypt ? '1' : '0',
        'x-upload-id': uploadId,
        'x-extra-headers': JSON.stringify(params.headers ?? {}),
      },
    })
    if (params.encrypt) {
      if (!result.key || !result.iv) {
        throw new Error('upload_file returned no encryption params for an encrypted upload')
      }
      return {
        cipher: 'aes-256-gcm',
        key: base64ToBytes(result.key),
        iv: base64ToBytes(result.iv),
      }
    }
    return undefined
  } finally {
    unlisten?.()
  }
}
