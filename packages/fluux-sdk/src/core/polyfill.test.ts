import { describe, it, expect, afterEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { ensureCryptoRandomUUID } from './polyfill'

describe('ensureCryptoRandomUUID', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('installs a spec-shaped randomUUID when missing (old WebKitGTK/Chromium)', () => {
    // Simulate an old webview: getRandomValues exists, randomUUID does not.
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array<ArrayBuffer>) => webcrypto.getRandomValues(arr),
    })

    ensureCryptoRandomUUID()

    const uuid = (globalThis.crypto as Crypto).randomUUID()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('creates the crypto global when entirely absent', () => {
    vi.stubGlobal('crypto', undefined)

    ensureCryptoRandomUUID()

    expect(typeof (globalThis.crypto as Crypto | undefined)?.randomUUID).toBe('function')
  })

  it('leaves a native implementation untouched', () => {
    const native = () => 'native-uuid' as ReturnType<Crypto['randomUUID']>
    vi.stubGlobal('crypto', { randomUUID: native })

    ensureCryptoRandomUUID()

    expect((globalThis.crypto as Crypto).randomUUID).toBe(native)
  })
})
