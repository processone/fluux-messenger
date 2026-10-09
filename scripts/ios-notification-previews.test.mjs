import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('notification preview fallbacks and completion', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-preview-test-'))
  const binary = join(scratch, 'preview-tests')
  try {
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', join(scratch, 'cache'),
      fileURLToPath(new URL('../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationPreviews/PreviewDelivery.swift', import.meta.url)),
      fileURLToPath(new URL('./native-tests/NotificationPreviewTests.swift', import.meta.url)), '-o', binary], { timeout: 120000 })
    assert.match(execFileSync(binary).toString(), /passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
