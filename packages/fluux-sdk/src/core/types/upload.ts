/**
 * File upload and attachment type definitions (XEP-0363, XEP-0066, XEP-0264).
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
 * Thumbnail information (XEP-0264).
 *
 * Used for image/video previews in file attachments.
 *
 * @category FileUpload
 */
export interface ThumbnailInfo {
  /** URL to the thumbnail image */
  uri: string
  /** MIME type (e.g., 'image/jpeg') */
  mediaType: string
  /** Width in pixels */
  width: number
  /** Height in pixels */
  height: number
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
 * thumbnails (XEP-0264), and file metadata (XEP-0446).
 *
 * @category FileUpload
 */
export interface FileAttachment {
  /** URL to the file (from HTTP Upload) */
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
}
