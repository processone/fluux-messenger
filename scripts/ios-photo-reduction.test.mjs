import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Real photos are not kept in the project: point FLUUX_PHOTO_FIXTURES at a folder of
// JPEG and HEIC photos (with location and a rotated portrait among them) and other images.
const fixtures = process.env.FLUUX_PHOTO_FIXTURES
test('large photos are reduced to clean, upright sRGB JPEG copies', {
  skip: process.platform !== 'darwin' || !fixtures,
}, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-photo-reduction-'))
  const binary = join(scratch, 'photo-preparation-test')
  const output = join(scratch, 'out')
  mkdirSync(output)
  try {
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', join(scratch, 'module-cache'),
      fileURLToPath(new URL('../apps/fluux/src-tauri/plugins/share-inbox/ios/Sources/PhotoPreparation.swift', import.meta.url)),
      fileURLToPath(new URL('./native-tests/PhotoPreparationTests.swift', import.meta.url)), '-o', binary], { timeout: 180000 })
    const report = execFileSync(binary, [fixtures, output], { timeout: 180000 }).toString()
    console.log(report)
    assert.match(report, /^REDUCED /m)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
