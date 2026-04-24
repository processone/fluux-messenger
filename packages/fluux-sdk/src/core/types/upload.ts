/**
 * File upload and attachment type definitions (XEP-0363, XEP-0066, XEP-0264,
 * XEP-0446, XEP-0454).
 *
 * @packageDocumentation
 * @module Types/Upload
 */

/**
 * HTTP Upload service information (XEP-0363).
 *
 * Discovered from the server's service discovery.
 *
 * @category FileUpload
 */
export interface HttpUploadService {
  /** Upload service JID (e.g., 'upload.example.com') */
  jid: string
  /** Maximum file size in bytes (from disco#info) */
  maxFileSize?: number
}

/**
 * Upload slot for HTTP File Upload (XEP-0363).
 *
 * Contains URLs for uploading and retrieving the file.
 *
 * @category FileUpload
 */
export interface UploadSlot {
  /** URL to PUT the file to */
  putUrl: string
  /** URL where file will be available after upload */
  getUrl: string
  /** Authorization headers required for PUT request */
  headers?: Record<string, string>
}

/**
 * Symmetric-encryption parameters carried alongside an encrypted file
 * reference (XEP-0454 / `aesgcm://` URI). Only populated when the URL
 * points at ciphertext stored on an HTTP Upload service; plain HTTPS
 * attachments leave this undefined.
 *
 * The UI layer is responsible for fetching the ciphertext and calling
 * `MediaEncryption.decryptFile` with these params before rendering.
 *
 * @category FileUpload
 */
export interface FileEncryption {
  /** Only AES-256-GCM is supported today (XEP-0454). */
  cipher: 'aes-256-gcm'
  /** 32-byte AES-256 key. One-shot — never reuse. */
  key: Uint8Array
  /** 12-byte AES-GCM IV. One-shot — never reuse. */
  iv: Uint8Array
}

/**
 * Thumbnail information (XEP-0264).
 *
 * Used for image/video previews in file attachments.
 *
 * @category FileUpload
 */
export interface ThumbnailInfo {
  /**
   * URL to the thumbnail image. Plain HTTPS for unencrypted attachments;
   * also plain HTTPS for encrypted attachments, with the key/IV carried
   * separately in `encryption` — renderers must decrypt ciphertext locally
   * before using it as an image source.
   */
  uri: string
  /** MIME type (e.g., 'image/jpeg') */
  mediaType: string
  /** Width in pixels */
  width: number
  /** Height in pixels */
  height: number
  /**
   * Present when the thumbnail bytes at `uri` are AES-GCM-encrypted. Only
   * set when the parent file attachment is also encrypted — a plaintext
   * thumbnail alongside an encrypted file would leak a preview of the
   * protected content.
   */
  encryption?: FileEncryption
}

/**
 * Out of Band Data (XEP-0066).
 *
 * @category FileUpload
 */
export interface OobInfo {
  /** URL to the file */
  url: string
  /** Optional file description */
  desc?: string
}

/**
 * File attachment in a message.
 *
 * Combined information from HTTP Upload (XEP-0363), OOB (XEP-0066),
 * thumbnails (XEP-0264), file metadata (XEP-0446), and optional AES-GCM
 * media encryption (XEP-0454).
 *
 * @category FileUpload
 */
export interface FileAttachment {
  /**
   * URL to the file. Plain HTTPS — encryption params, if any, ride in
   * `encryption`, NOT the URL fragment. The SDK rebuilds the wire-format
   * `aesgcm://` URI only at stanza-assembly time (and only inside the
   * E2EE `<payload/>`).
   */
  url: string
  /** Original filename */
  name?: string
  /** File size in bytes */
  size?: number
  /** MIME type */
  mediaType?: string
  /** XEP-0446: Width in pixels (for images/videos) */
  width?: number
  /** XEP-0446: Height in pixels (for images/videos) */
  height?: number
  /** XEP-0264: Thumbnail for images/videos */
  thumbnail?: ThumbnailInfo
  /** Duration in seconds (for audio/video) */
  duration?: number
  /**
   * Present when the file at `url` is AES-GCM-encrypted ciphertext
   * (XEP-0454). Absent for plaintext attachments. Renderers MUST call
   * `MediaEncryption.decryptFile` with these params before displaying the
   * file, and MUST refuse to render on any decryption failure.
   */
  encryption?: FileEncryption
}
