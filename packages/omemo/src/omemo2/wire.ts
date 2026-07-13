import { concatBytes } from '../primitives/bytes'

// Minimal hand-rolled protobuf codec for the three OMEMO 2 (XEP-0384 §4.2) wire messages.
// Only two wire types are used by this schema: 0 = varint (uint32 ids), 2 = length-delimited (bytes).
// No external protobuf dependency — field numbers and wire types below are an exact interop contract
// with Conversations/python-omemo and must not be changed casually.

const WIRE_VARINT = 0
const WIRE_LENGTH_DELIMITED = 2

// --- encoding primitives ---

function encodeVarint(n: number): Uint8Array {
  const out: number[] = []
  let v = n >>> 0
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return Uint8Array.from(out)
}

function tag(fieldNo: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNo << 3) | wireType)
}

function varintField(fieldNo: number, value: number): Uint8Array {
  return concatBytes(tag(fieldNo, WIRE_VARINT), encodeVarint(value))
}

function bytesField(fieldNo: number, value: Uint8Array): Uint8Array {
  return concatBytes(tag(fieldNo, WIRE_LENGTH_DELIMITED), encodeVarint(value.length), value)
}

// --- decoding primitives ---

interface Reader {
  buf: Uint8Array
  off: number
}

function readVarint(r: Reader): number {
  let shift = 0
  let result = 0
  for (;;) {
    if (r.off >= r.buf.length) throw new Error('omemo2 wire: truncated varint')
    const byte = r.buf[r.off++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return result >>> 0
}

function readBytes(r: Reader): Uint8Array {
  const len = readVarint(r)
  if (r.off + len > r.buf.length) throw new Error('omemo2 wire: truncated length-delimited field')
  const out = r.buf.slice(r.off, r.off + len)
  r.off += len
  return out
}

/** Reads a field tag and splits it into field number + wire type. */
function readTag(r: Reader): { field: number; wireType: number } {
  const t = readVarint(r)
  return { field: t >>> 3, wireType: t & 0x7 }
}

/** Skips a field's value by wire type, for forward-compat with unknown field numbers. */
function skipField(r: Reader, wireType: number): void {
  if (wireType === WIRE_VARINT) {
    readVarint(r)
  } else if (wireType === WIRE_LENGTH_DELIMITED) {
    readBytes(r)
  } else {
    throw new Error(`omemo2 wire: unsupported wire type ${wireType}`)
  }
}

// --- OMEMOMessage { n=1 (varint), pn=2 (varint), dh_pub=3 (bytes), ciphertext=4 (bytes, optional) } ---

export interface OmemoWireMessage {
  n: number
  pn: number
  dhPub: Uint8Array
  ciphertext?: Uint8Array
}

export function encodeOmemoMessage(m: OmemoWireMessage): Uint8Array {
  const parts = [varintField(1, m.n), varintField(2, m.pn), bytesField(3, m.dhPub)]
  if (m.ciphertext !== undefined) parts.push(bytesField(4, m.ciphertext))
  return concatBytes(...parts)
}

export function decodeOmemoMessage(b: Uint8Array): OmemoWireMessage {
  const r: Reader = { buf: b, off: 0 }
  const out: OmemoWireMessage = { n: 0, pn: 0, dhPub: new Uint8Array(0) }
  while (r.off < b.length) {
    const { field, wireType } = readTag(r)
    if (field === 1) out.n = readVarint(r)
    else if (field === 2) out.pn = readVarint(r)
    else if (field === 3) out.dhPub = readBytes(r)
    else if (field === 4) out.ciphertext = readBytes(r)
    else skipField(r, wireType)
  }
  return out
}

// --- OMEMOAuthenticatedMessage { mac=1 (bytes), message=2 (bytes) } ---

export interface OmemoAuthMessage {
  mac: Uint8Array
  message: Uint8Array
}

export function encodeAuthMessage(m: OmemoAuthMessage): Uint8Array {
  return concatBytes(bytesField(1, m.mac), bytesField(2, m.message))
}

export function decodeAuthMessage(b: Uint8Array): OmemoAuthMessage {
  const r: Reader = { buf: b, off: 0 }
  const out: OmemoAuthMessage = { mac: new Uint8Array(0), message: new Uint8Array(0) }
  while (r.off < b.length) {
    const { field, wireType } = readTag(r)
    if (field === 1) out.mac = readBytes(r)
    else if (field === 2) out.message = readBytes(r)
    else skipField(r, wireType)
  }
  return out
}

// --- OMEMOKeyExchange { pk_id=1 (varint), spk_id=2 (varint), ik=3 (bytes), ek=4 (bytes), message=5 (bytes) } ---
// `message` (field 5) carries the byte-serialized OMEMOAuthenticatedMessage.

export interface OmemoKeyExchange {
  pkId: number
  spkId: number
  ik: Uint8Array
  ek: Uint8Array
  message: Uint8Array
}

export function encodeKeyExchange(m: OmemoKeyExchange): Uint8Array {
  return concatBytes(
    varintField(1, m.pkId),
    varintField(2, m.spkId),
    bytesField(3, m.ik),
    bytesField(4, m.ek),
    bytesField(5, m.message),
  )
}

export function decodeKeyExchange(b: Uint8Array): OmemoKeyExchange {
  const r: Reader = { buf: b, off: 0 }
  const out: OmemoKeyExchange = {
    pkId: 0,
    spkId: 0,
    ik: new Uint8Array(0),
    ek: new Uint8Array(0),
    message: new Uint8Array(0),
  }
  while (r.off < b.length) {
    const { field, wireType } = readTag(r)
    if (field === 1) out.pkId = readVarint(r)
    else if (field === 2) out.spkId = readVarint(r)
    else if (field === 3) out.ik = readBytes(r)
    else if (field === 4) out.ek = readBytes(r)
    else if (field === 5) out.message = readBytes(r)
    else skipField(r, wireType)
  }
  return out
}
