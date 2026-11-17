/**
 * Parsing for the plaintext recovered from a decrypted secret-key backup.
 *
 * The decrypted payload comes in two shapes Fluux must accept:
 *
 *  - **Binary TSK** — what Fluux's own web backups and the Sequoia desktop
 *    side produce (`createMessage({ binary })` / `Encryptor`). Parsed with
 *    `readPrivateKeys({ binaryKeys })`.
 *  - **ASCII-armored key blocks** — what OpenKeychain produces: a
 *    `PGP PUBLIC KEY BLOCK` *followed by* a `PGP PRIVATE KEY BLOCK`. Older
 *    web backups also stored a single armored private key here. openpgp.js
 *    `readPrivateKeys({ armoredKeys })` reads only the first armor block and
 *    rejects a leading public block with "Armored text not of type private
 *    key", so we split the blocks and keep the ones bearing secret material.
 *
 * Detection is on the payload's first meaningful byte rather than a
 * try/catch dance, so a malformed binary TSK reports a binary parse error
 * instead of being silently retried as text.
 */
import type { PrivateKey } from 'openpgp'

/**
 * True when `bytes` is ASCII-armored OpenPGP text (begins with `-----`),
 * false when it is a binary OpenPGP stream. Binary OpenPGP packets always
 * have bit 7 set in their first octet (tag byte ≥ 0x80), while armor starts
 * with `-` (0x2d); the two ranges never overlap. Tolerates a leading UTF-8
 * BOM and ASCII whitespace, which text-mode writers occasionally prepend.
 */
export function isArmoredKeyText(bytes: Uint8Array): boolean {
  let i = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3 // UTF-8 BOM
  for (; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0x09 || b === 0x0a || b === 0x0d || b === 0x20) continue // tab/LF/CR/space
    return b === 0x2d // '-'
  }
  return false
}

/**
 * Split concatenated ASCII-armored blocks into individual armor strings,
 * preserving order. Returns `[]` when no block is found.
 */
export function splitArmorBlocks(text: string): string[] {
  return (
    text.match(/-----BEGIN PGP [A-Z0-9 ]+?-----[\s\S]*?-----END PGP [A-Z0-9 ]+?-----/g) ?? []
  )
}

/**
 * Parse all secret keys from a decrypted backup payload, transparently
 * handling both the binary-TSK and armored-key-block shapes. Throws when the
 * payload contains no secret-key material (e.g. a public-key-only export).
 */
export async function parseSecretKeysFromBackupPayload(bytes: Uint8Array): Promise<PrivateKey[]> {
  const { readPrivateKeys } = await import('openpgp')

  if (isArmoredKeyText(bytes)) {
    const text = new TextDecoder().decode(bytes)
    const keys: PrivateKey[] = []
    for (const block of splitArmorBlocks(text)) {
      try {
        keys.push(...(await readPrivateKeys({ armoredKeys: block })))
      } catch {
        // Public-key block (OpenKeychain emits one before the private block)
        // or any other non-secret armor — skip it.
      }
    }
    if (keys.length === 0) {
      throw new Error('backup payload contained no secret-key material')
    }
    return keys
  }

  return readPrivateKeys({ binaryKeys: bytes })
}
