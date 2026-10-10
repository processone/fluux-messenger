import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
const path = relative => fileURLToPath(new URL(relative, import.meta.url))
test('account-owned iOS suggestions and notification sounds', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-ios-quick-wins-'))
  try {
    const binary = join(scratch, 'tests')
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', join(scratch, 'cache'),
      ...['SharedNotificationStore', 'ConversationDestination', 'NotificationSoundSettings'].map(name => path(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationAvatars/${name}.swift`)),
      path('./native-tests/IOSQuickWinsTests.swift'), '-o', binary], { timeout: 120000 })
    assert.match(execFileSync(binary).toString(), /passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
test('bundled alert tones use PCM WAV and last less than 30 seconds', () => {
  const root = path('../apps/fluux/src-tauri/mobile/ios/Sounds')
  assert.equal(readdirSync(root).length, 3)
  for (const name of readdirSync(root)) {
    const wav = readFileSync(join(root, name))
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
    assert.equal(wav.readUInt16LE(20), 1)
    const byteRate = wav.readUInt32LE(28)
    assert.ok((wav.length - 44) / byteRate < 30)
  }
})
