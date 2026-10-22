import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('issue #1386 macOS communication prototype contracts (no signing or installed application)', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-communication-'))
  try {
    const source = resolve('apps/fluux/src-tauri/macos/CommunicationNotification.m')
    // Keep the old minimum and reject any newly unguarded API, independently of the runtime test target.
    execFileSync('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-mmacosx-version-min=10.13',
      '-Werror=unguarded-availability-new', '-fsyntax-only', source], { stdio: 'pipe' })
    const binary = join(scratch, 'contracts')
    execFileSync('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-mmacosx-version-min=12.0', source,
      resolve('scripts/native-tests/MacCommunicationTests.m'), '-framework', 'Foundation', '-framework', 'AppKit',
      '-framework', 'Intents', '-framework', 'UserNotifications', '-o', binary], { stdio: 'pipe' })
    const transcript = execFileSync(binary, [resolve('apps/fluux/public/logo.png')], { encoding: 'utf8', timeout: 30000 })
    console.log(transcript.trim())
    assert.match(transcript, /contracts passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
