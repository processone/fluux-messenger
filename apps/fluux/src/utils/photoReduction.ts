/**
 * Reduction of large photos before they are sent, as accepted for iOS in FLM-22.
 *
 * This module owns the policy: which photos are reduced, which attempts are
 * tried and which result is kept. The pixels are read and re-encoded natively
 * (`share-inbox/ios/Sources/PhotoPreparation.swift`) behind {@link PhotoSource}.
 * Nothing here uploads: a prepared copy leaves the device only on Send.
 */

/** WebCrypto and the native uploader append a 128-bit AES-GCM tag, so ciphertext = plaintext + 16. */
export const GCM_TAG_BYTES = 16

/** A photo heavier than this is reduced. */
export const REDUCE_ABOVE_BYTES = 4 * 1024 * 1024
/** A photo whose longer side exceeds this many pixels is reduced. */
export const REDUCE_ABOVE_SIDE = 4096
/** The first attempt at or under this weight is kept; a soft target, never a promise. */
export const TARGET_BYTES = 2 * 1024 * 1024
/** A copy must be at least this much lighter than its source to be worth sending. */
export const MIN_GAIN = 0.1
/** Each attempt starts again from the source, never from an earlier copy. */
export const ATTEMPTS = [
  { maxSide: 2560, quality: 0.85 },
  { maxSide: 2048, quality: 0.8 },
  { maxSide: 1600, quality: 0.75 },
] as const

export type AttemptSettings = (typeof ATTEMPTS)[number]

/** Still-photo types that may be reduced. PNG, GIF, WebP, SVG, RAW and documents stay as they are. */
const PHOTO_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', heic: 'image/heic', heif: 'image/heif' }

/** The photo type of a file that may be reduced, from its type or else its extension; null otherwise. */
export function reduciblePhotoType(file: { name: string; type: string }): string | null {
  if (Object.values(PHOTO_TYPES).includes(file.type)) return file.type
  if (file.type && file.type !== 'application/octet-stream') return null
  return PHOTO_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? null
}

/** Whether `size` bytes fit the server's limit, counting the encryption tag when encrypted. */
export function fitsUpload(size: number, limit: number | undefined, encrypted: boolean): boolean {
  return !limit || size + (encrypted ? GCM_TAG_BYTES : 0) <= limit
}

/** What the native side reads from a photo's header, without decoding its pixels. */
export interface PhotoProbe {
  /** The decoder's own type identifier, such as `public.jpeg`. */
  type: string
  /** Displayed width, with the orientation applied. */
  width: number
  height: number
  /** A single still JPEG or HEIF image, which the native side can re-encode. */
  reducible: boolean
}

export interface EncodedPhoto {
  width: number
  height: number
  size: number
}

/**
 * Reducing is triggered by weight, definition, or the server's limit. A value
 * equal to a threshold does not trigger it. Encryption is assumed, so a copy
 * chosen now still fits if the conversation is encrypted at Send.
 */
export function needsReduction(size: number, probe: PhotoProbe, limit: number | undefined): boolean {
  return probe.reducible && (size > REDUCE_ABOVE_BYTES
    || Math.max(probe.width, probe.height) > REDUCE_ABOVE_SIDE
    || !fitsUpload(size, limit, true))
}

export type Reduction =
  | { kind: 'reduced'; attempt: number; photo: EncodedPhoto }
  /** `no-gain`: no attempt saved 10%. `too-large`: none that did fits the server. */
  | { kind: 'unchanged'; reason: 'no-gain' | 'too-large' }

/**
 * Tries the attempts in order and keeps the first that reaches the target,
 * otherwise the lightest allowed one. An attempt is allowed when it saves at
 * least {@link MIN_GAIN} and fits the server's limit.
 */
export async function chooseReduction(
  size: number,
  limit: number | undefined,
  encode: (attempt: number, settings: AttemptSettings) => Promise<EncodedPhoto>,
): Promise<Reduction> {
  let lightest: { attempt: number; photo: EncodedPhoto } | null = null
  let gained = false
  for (const [attempt, settings] of ATTEMPTS.entries()) {
    const photo = await encode(attempt, settings)
    if (photo.size > size * (1 - MIN_GAIN)) continue
    gained = true
    if (!fitsUpload(photo.size, limit, true)) continue
    if (photo.size <= TARGET_BYTES) return { kind: 'reduced', attempt, photo }
    if (!lightest || photo.size < lightest.photo.size) lightest = { attempt, photo }
  }
  if (lightest) return { kind: 'reduced', ...lightest }
  return { kind: 'unchanged', reason: gained ? 'too-large' : 'no-gain' }
}

/** A photo held natively: an import of the share extension, or a photo staged by the app. */
export interface PhotoSource {
  probe(): Promise<PhotoProbe>
  encode(attempt: number, settings: AttemptSettings): Promise<EncodedPhoto>
  read(attempt: number): Promise<ArrayBuffer>
}

export interface Dimensions {
  width: number
  height: number
}

export type PreparedPhoto =
  /** Not a photo to reduce: it is sent as it is, as before. */
  | { kind: 'skip' }
  | { kind: 'reduced'; file: File; source: Dimensions; reduced: Dimensions }
  | { kind: 'unchanged'; reason: 'no-gain' | 'too-large'; source: Dimensions }

/** The copy is a JPEG named after its source. */
export function reducedName(name: string): string {
  const stem = name.replace(/\.[^./]*$/, '')
  return `${stem || 'photo'}.jpg`
}

/** Rejects when the photo cannot be read or reduced; the caller then asks the user. */
export async function preparePhoto(
  name: string,
  size: number,
  source: PhotoSource,
  limit: number | undefined,
): Promise<PreparedPhoto> {
  const probe = await source.probe()
  if (!needsReduction(size, probe, limit)) return { kind: 'skip' }
  const dimensions = { width: probe.width, height: probe.height }
  const reduction = await chooseReduction(size, limit, (attempt, settings) => source.encode(attempt, settings))
  if (reduction.kind === 'unchanged') return { kind: 'unchanged', reason: reduction.reason, source: dimensions }
  const bytes = await source.read(reduction.attempt)
  if (bytes.byteLength !== reduction.photo.size) throw new Error('Incomplete reduced photo')
  return {
    kind: 'reduced',
    file: new File([bytes], reducedName(name), { type: 'image/jpeg' }),
    source: dimensions,
    reduced: { width: reduction.photo.width, height: reduction.photo.height },
  }
}
