import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// FLM-279: the posture and hinge line Fluux reports to the page on a half-open iPhone Duo.
// HingeLayout.swift needs only CoreGraphics, so it runs on the Mac without a simulator.
test('the hinge line follows the division band UIKit reports on the iPhone Duo', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-hinge-layout-'))
  const binary = join(scratch, 'hinge-layout-test')
  try {
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', join(scratch, 'module-cache'),
      fileURLToPath(new URL('../apps/fluux/src-tauri/plugins/ios-feedback/ios/Sources/HingeLayout.swift', import.meta.url)),
      fileURLToPath(new URL('./native-tests/HingeLayoutTests.swift', import.meta.url)), '-o', binary], { timeout: 180000 })
    assert.match(execFileSync(binary).toString(), /Hinge layout passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
