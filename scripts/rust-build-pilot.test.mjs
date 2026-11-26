import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync, utimesSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { CAP, compatibility, IDLE_MS, prune } from './rust-build-pilot.mjs'

// Source: the approved pilot requires separation of incompatible native builds.
test('real host compatibility keys isolate feature, flags, target and compiler overrides', { skip: process.platform !== 'linux' }, () => {
  const options = { operation: 'build', features: '', env: process.env }
  const original = compatibility(options)
  assert.equal(compatibility(options), original)
  for (const variant of [
    { features: 'startup-recovery-lab' },
    { operation: 'test' },
    { env: { ...process.env, RUSTFLAGS: '-Cdebuginfo=0' } },
    { env: { ...process.env, CARGO_BUILD_TARGET: 'aarch64-unknown-linux-gnu' } },
    { env: { ...process.env, RUSTC: '/unavailable/compiler' } },
    { env: { ...process.env, CC: '/unavailable/linker' } },
    { env: { ...process.env, CARGO_PROFILE_DEV_OPT_LEVEL: '1' } },
  ]) assert.notEqual(compatibility({ ...options, ...variant }), original)
})

// Source: the approved pilot permits only bounded, non-idle retained entries.
test('eviction removes idle and least-recent entries, never the lock', () => {
  const cache = mkdtempSync(join(tmpdir(), 'fluux-rust-policy-'))
  try {
    const names = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
    const now = Date.now()
    names.forEach((name, index) => {
      const path = join(cache, name)
      mkdirSync(path)
      copyFileSync('apps/fluux/src-tauri/Cargo.lock', join(path, 'Cargo.lock'))
      writeFileSync(join(path, 'used'), '')
      const used = new Date(now - (index === 0 ? IDLE_MS + 1000 : 3000 - index * 1000))
      utimesSync(join(path, 'used'), used, used)
    })
    writeFileSync(join(cache, '.lock'), '')
    const newest = join(cache, names[2])
    const newestBytes = statSync(newest).size + statSync(join(newest, 'Cargo.lock')).size + statSync(join(newest, 'used')).size
    const retained = prune(cache, now, newestBytes)
    assert.equal(existsSync(join(cache, names[0])), false)
    assert.equal(existsSync(join(cache, names[1])), false)
    assert.equal(existsSync(join(cache, names[2])), true)
    assert.equal(existsSync(join(cache, '.lock')), true)
    assert.equal(retained, newestBytes)
    assert.equal(prune(cache, now, newestBytes - 1), 0)
    assert.equal(existsSync(join(cache, names[2])), false)
    assert.equal(CAP, 10 * 1024 ** 3)
  } finally { rmSync(cache, { recursive: true, force: true }) }
})

// Source: separate final outputs must never be mixed with intermediates.
test('the public runner rejects overlapping outputs before launching Cargo', { skip: process.platform !== 'linux' }, () => {
  const cache = resolve(tmpdir(), 'fluux-pilot-overlap')
  for (const target of [cache, join(cache, 'target'), resolve(cache, '..')]) {
    const result = spawnSync(process.execPath, ['scripts/rust-build-pilot.mjs', '--cache', cache, '--target', target, '--shared'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /must not overlap/)
  }
})
