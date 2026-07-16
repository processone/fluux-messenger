// @vitest-environment node
/**
 * Unit tests for the decrypted-backup-payload parser. Runs under `node`
 * because openpgp.js performs realm-sensitive Uint8Array checks that fail
 * under jsdom.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { PrivateKey } from 'openpgp'
import {
  isArmoredKeyText,
  splitArmorBlocks,
  parseSecretKeysFromBackupPayload,
} from './backupKeyMaterial'

const enc = (s: string) => new TextEncoder().encode(s)

let tsk: PrivateKey
let binaryTsk: Uint8Array
let publicArmor: string
let privateArmor: string

beforeAll(async () => {
  const openpgp = await import('openpgp')
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ name: 'xmpp:test@example.com' }],
    format: 'object',
  })
  tsk = privateKey
  binaryTsk = privateKey.write() as Uint8Array
  publicArmor = privateKey.toPublic().armor()
  privateArmor = privateKey.armor()
})

describe('isArmoredKeyText', () => {
  it('detects ASCII-armored text', () => {
    expect(isArmoredKeyText(enc('-----BEGIN PGP PRIVATE KEY BLOCK-----\nx'))).toBe(true)
  })

  it('tolerates leading whitespace and a UTF-8 BOM', () => {
    expect(isArmoredKeyText(enc('\n   -----BEGIN PGP MESSAGE-----'))).toBe(true)
    expect(isArmoredKeyText(new Uint8Array([0xef, 0xbb, 0xbf, 0x2d, 0x2d, 0x2d]))).toBe(true)
  })

  it('treats a binary TSK as not armored', () => {
    expect(binaryTsk[0]).toBeGreaterThanOrEqual(0x80) // OpenPGP packet tag byte
    expect(isArmoredKeyText(binaryTsk)).toBe(false)
  })
})

describe('splitArmorBlocks', () => {
  it('splits a public-then-private payload into two ordered blocks', () => {
    const blocks = splitArmorBlocks(`${publicArmor}\n${privateArmor}`)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toContain('PUBLIC KEY BLOCK')
    expect(blocks[1]).toContain('PRIVATE KEY BLOCK')
  })

  it('returns [] when there is no armor', () => {
    expect(splitArmorBlocks('not pgp at all')).toEqual([])
  })
})

describe('parseSecretKeysFromBackupPayload', () => {
  it('parses a binary TSK', async () => {
    const keys = await parseSecretKeysFromBackupPayload(binaryTsk)
    expect(keys.map((k) => k.getFingerprint())).toEqual([tsk.getFingerprint()])
  })

  it('parses the private key from a public-then-private armored payload (OpenKeychain)', async () => {
    const keys = await parseSecretKeysFromBackupPayload(enc(`${publicArmor}\n${privateArmor}`))
    expect(keys.map((k) => k.getFingerprint())).toEqual([tsk.getFingerprint()])
    expect(keys[0].isDecrypted()).toBe(true)
  })

  it('parses a single armored private key (legacy web backup)', async () => {
    const keys = await parseSecretKeysFromBackupPayload(enc(privateArmor))
    expect(keys.map((k) => k.getFingerprint())).toEqual([tsk.getFingerprint()])
  })

  it('throws when the payload has no secret-key material', async () => {
    await expect(parseSecretKeysFromBackupPayload(enc(publicArmor))).rejects.toThrow(
      /no secret-key material/,
    )
  })
})
