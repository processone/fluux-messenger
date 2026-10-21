import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('FLM-31 content-free local diagnostic lifecycle', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-diagnostic-'))
  try {
    const binary = join(scratch, 'diagnostic')
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', join(scratch, 'cache'),
      'apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationPreviews/PreviewTrace.swift',
      'scripts/native-tests/NotificationDiagnosticTests.swift', '-lsqlite3', '-o', binary], { timeout: 120000 })
    const config = JSON.parse(readFileSync('apps/fluux/src-tauri/tauri.conf.json', 'utf8'))
    assert.match(execFileSync(binary, [`${config.version} (test)`], { encoding: 'utf8' }), /passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
