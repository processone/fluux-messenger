import { concatBytes, u32be } from '../primitives/bytes'
import type { Rng } from '../primitives/bytes'

/**
 * Content of an SCE (XEP-0420) envelope, before the XML shape is applied by an adapter.
 * This module only serializes/parses the byte payload that the crypto layer encrypts.
 */
export interface SceContent {
  body?: string
  from?: string
  to?: string
  timeIso?: string
}

type Field = 'body' | 'from' | 'to' | 'timeIso' | 'rpad'

const MAX_RPAD_LEN = 32

function field(tag: Field, value: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(tag)
  return concatBytes(u32be(t.length), t, u32be(value.length), value)
}

/**
 * Builds the SCE envelope bytes: length-prefixed `tag||value` fields for each present
 * optional field, followed by a mandatory random `rpad` field (length-hiding, 1..32 bytes,
 * drawn from the injected rng). The output is a stable, reversible byte format; the exact
 * XEP-0420 XML shape is the adapter's responsibility, not this module's.
 */
export function buildEnvelope(content: SceContent, rng: Rng): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  if (content.body !== undefined) parts.push(field('body', enc.encode(content.body)))
  if (content.from !== undefined) parts.push(field('from', enc.encode(content.from)))
  if (content.to !== undefined) parts.push(field('to', enc.encode(content.to)))
  if (content.timeIso !== undefined) parts.push(field('timeIso', enc.encode(content.timeIso)))
  const rpadLen = (rng(1)[0] % MAX_RPAD_LEN) + 1
  parts.push(field('rpad', rng(rpadLen)))
  return concatBytes(...parts)
}

/** Reverses buildEnvelope. The rpad field is intentionally discarded. */
export function parseEnvelope(bytes: Uint8Array): SceContent {
  const dec = new TextDecoder()
  const out: SceContent = {}
  let off = 0
  const readU32 = () => {
    const v = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]
    off += 4
    return v >>> 0
  }
  while (off < bytes.length) {
    const tagLen = readU32()
    const tag = dec.decode(bytes.slice(off, off + tagLen))
    off += tagLen
    const valLen = readU32()
    const val = bytes.slice(off, off + valLen)
    off += valLen
    if (tag === 'body') out.body = dec.decode(val)
    else if (tag === 'from') out.from = dec.decode(val)
    else if (tag === 'to') out.to = dec.decode(val)
    else if (tag === 'timeIso') out.timeIso = dec.decode(val)
    // rpad is intentionally discarded
  }
  return out
}
