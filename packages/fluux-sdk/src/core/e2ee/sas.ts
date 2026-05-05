/**
 * Short Authentication String (SAS) for peer fingerprint verification.
 *
 * The SAS reduces an OpenPGP fingerprint pair to 8 decimal digits split
 * in two halves of 4. The intended UX is "cross-spoken": each peer reads
 * one half aloud while the other types it in. Both halves match only
 * when both clients see the same fingerprint pair — i.e. there is no
 * MITM swapping keys in transit. 8 digits give ~26.5 bits of entropy,
 * which makes a successful active attack a ~1-in-10^8 event per try.
 *
 * The derivation is symmetric: the inputs are sorted lexicographically
 * before hashing so both peers compute the same code regardless of who
 * is "self" vs "peer".
 */

/** Strip whitespace and common separators, then lower-case. */
function normalize(fp: string): string {
  return fp.replace(/[\s:_-]/g, '').toLowerCase()
}

/** SHA-256 → first 8 bytes → BigInt → mod 10^8 → 8-digit string. */
async function digestToDigits(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const hashBuf = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const view = new DataView(hashBuf)
  // Read first 8 bytes big-endian.
  const hi = BigInt(view.getUint32(0, false))
  const lo = BigInt(view.getUint32(4, false))
  const combined = (hi << 32n) | lo
  const code = combined % 100_000_000n
  return code.toString().padStart(8, '0')
}

/**
 * Derive a symmetric 8-digit SAS from two OpenPGP fingerprints.
 *
 * Both peers compute the same code regardless of which fingerprint they
 * pass first because the inputs are normalized then sorted before
 * hashing. The `:` separator prevents trivial collisions of the form
 * `("abcd", "ef")` vs `("abc", "def")`.
 */
export async function deriveSas(
  fpA: string,
  fpB: string,
): Promise<{ firstHalf: string; secondHalf: string }> {
  const a = normalize(fpA)
  const b = normalize(fpB)
  const [low, high] = a < b ? [a, b] : [b, a]
  const digits = await digestToDigits(`${low}:${high}`)
  return { firstHalf: digits.slice(0, 4), secondHalf: digits.slice(4, 8) }
}

/**
 * Decide which half this client OWNS (reads aloud) vs RECEIVES (the
 * peer reads, the user types). The split is by lexicographic order of
 * the bare JIDs after normalization: the alphabetically-first JID owns
 * `firstHalf`. Both clients reach the same assignment because both
 * know both JIDs.
 */
export function splitSas(
  ownJid: string,
  peerJid: string,
  sas: { firstHalf: string; secondHalf: string },
): { mine: string; theirs: string } {
  // Strip the resource so a full JID `user@host/resource` and the
  // matching bare JID `user@host` produce the same split. Both peers
  // see each other's bare JIDs in the contact list, but the local
  // connection's JID may include a resource — normalize either way.
  const own = ownJid.toLowerCase().split('/')[0]
  const peer = peerJid.toLowerCase().split('/')[0]
  if (own < peer) {
    return { mine: sas.firstHalf, theirs: sas.secondHalf }
  }
  return { mine: sas.secondHalf, theirs: sas.firstHalf }
}
