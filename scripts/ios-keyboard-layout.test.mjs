import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// CoreGraphics keeps the native geometry guard executable without a simulator or signing.
test('only a full-width keyboard covering the bottom can reclaim the gesture inset', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-keyboard-layout-'))
  const binary = join(scratch, 'keyboard-layout-test')
  try {
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', join(scratch, 'module-cache'),
      fileURLToPath(new URL('../apps/fluux/src-tauri/plugins/ios-feedback/ios/Sources/KeyboardLayout.swift', import.meta.url)),
      fileURLToPath(new URL('./native-tests/KeyboardLayoutTests.swift', import.meta.url)), '-o', binary], { timeout: 180000 })
    assert.match(execFileSync(binary).toString(), /Keyboard layout passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
