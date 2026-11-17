import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeInstallDrift, findInstallDrift } from './check-install-lock.mjs'

const SCRIPT = fileURLToPath(new URL('./check-install-lock.mjs', import.meta.url))

/** The lockfile a small workspace checkout would have, one entry per installed path. */
function lockfile() {
  return {
    name: 'fixture',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'fixture', workspaces: ['packages/*'] },
      'packages/lib': { name: '@fixture/lib', version: '1.0.0' },
      'node_modules/@fixture/lib': { resolved: 'packages/lib', link: true },
      'node_modules/vite': { version: '8.1.0', dev: true },
      'node_modules/vite/node_modules/rolldown': { version: '1.3.2', dev: true },
      'node_modules/@babel/core': { version: '7.29.13', dev: true },
      'node_modules/fsevents': { version: '2.3.3', dev: true, optional: true, os: ['darwin'] },
      'node_modules/string-width-cjs': { name: 'string-width', version: '4.2.3', dev: true },
      'packages/lib/node_modules/picomatch': { version: '4.0.4', dev: true },
    },
  }
}

function writePackage(root, key, manifest) {
  mkdirSync(join(root, key), { recursive: true })
  writeFileSync(join(root, key, 'package.json'), JSON.stringify(manifest))
}

/** A checkout whose install matches lockfile(): what `npm ci` on a non-darwin machine leaves. */
function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), 'check-install-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lockfile()))
  writePackage(root, 'packages/lib', { name: '@fixture/lib', version: '1.0.0' })
  mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true })
  symlinkSync('../../packages/lib', join(root, 'node_modules/@fixture/lib'), 'dir')
  writePackage(root, 'node_modules/vite', { name: 'vite', version: '8.1.0' })
  writePackage(root, 'node_modules/vite/node_modules/rolldown', { name: 'rolldown', version: '1.3.2' })
  writePackage(root, 'node_modules/@babel/core', { name: '@babel/core', version: '7.29.13' })
  writePackage(root, 'node_modules/string-width-cjs', { name: 'string-width', version: '4.2.3' })
  writePackage(root, 'packages/lib/node_modules/picomatch', { name: 'picomatch', version: '4.0.4' })
  // Not packages: npm's own state and tool caches.
  mkdirSync(join(root, 'node_modules/.bin'))
  writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}')
  writePackage(root, 'node_modules/.vite/deps', { name: 'deps', version: '0.0.0' })
  return root
}

function runCli(root) {
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
}

test('an install that matches the lockfile has no differences, without the optional package npm skipped', t => {
  const root = checkout(t)
  const result = findInstallDrift(root)
  assert.equal(result.problem, null)
  assert.deepEqual(result.differences, [])
  assert.equal(result.entries, 7)

  const cli = runCli(root)
  assert.equal(cli.status, 0, cli.stderr)
  assert.match(cli.stdout, /node_modules matches package-lock\.json \(7 locked package paths\)/)
})

test('an installed version older than the lockfile is stale, and the gate is told to run npm ci', t => {
  const root = checkout(t)
  writePackage(root, 'node_modules/@babel/core', { name: '@babel/core', version: '7.29.7' })
  assert.deepEqual(findInstallDrift(root).differences, [
    { path: 'node_modules/@babel/core', locked: '7.29.13', installed: '7.29.7' },
  ])

  const cli = runCli(root)
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /node_modules does not match package-lock\.json: the install is stale\./)
  assert.match(cli.stderr, /1 package path differs from the lockfile:/)
  assert.match(cli.stderr, /node_modules\/@babel\/core {2}locked: 7\.29\.13, installed: 7\.29\.7/)
  assert.ok(cli.stderr.includes(`cd ${JSON.stringify(root)} && npm ci`), cli.stderr)
})

test('a locked package that is not installed is stale unless it is optional', t => {
  const root = checkout(t)
  rmSync(join(root, 'node_modules/vite/node_modules'), { recursive: true })
  assert.deepEqual(findInstallDrift(root).differences, [
    { path: 'node_modules/vite/node_modules/rolldown', locked: '1.3.2', installed: 'not installed' },
  ])
})

test('an optional package that is installed must still have the locked version', t => {
  const root = checkout(t)
  writePackage(root, 'node_modules/fsevents', { name: 'fsevents', version: '2.3.2' })
  assert.deepEqual(findInstallDrift(root).differences, [
    { path: 'node_modules/fsevents', locked: '2.3.3', installed: '2.3.2' },
  ])
})

test('a leftover nested copy the lockfile no longer lists is stale, reported once with its contents', t => {
  const root = checkout(t)
  writePackage(root, 'packages/lib/node_modules/@rolldown/plugin-babel', { name: '@rolldown/plugin-babel', version: '0.3.1' })
  writePackage(root, 'packages/lib/node_modules/@rolldown/plugin-babel/node_modules/x', { name: 'x', version: '1.0.0' })
  writePackage(root, 'node_modules/vite/node_modules/esbuild', { name: 'esbuild', version: '0.27.0' })
  // A folder with no package.json is not something Node resolves.
  mkdirSync(join(root, 'node_modules/empty-leftover'))
  assert.deepEqual(findInstallDrift(root).differences, [
    { path: 'node_modules/vite/node_modules/esbuild', locked: 'not in the lockfile', installed: '0.27.0' },
    { path: 'packages/lib/node_modules/@rolldown/plugin-babel', locked: 'not in the lockfile', installed: '0.3.1' },
  ])
})

test('a package replaced by another under the same path is stale, and an alias is matched by its real name', t => {
  const root = checkout(t)
  writePackage(root, 'node_modules/vite', { name: 'rolldown-vite', version: '8.1.0' })
  assert.deepEqual(findInstallDrift(root).differences, [
    { path: 'node_modules/vite', locked: 'vite 8.1.0', installed: 'rolldown-vite 8.1.0' },
  ])
})

test('a workspace link must stay a link, and a locked folder must not be a link', t => {
  const root = checkout(t)
  rmSync(join(root, 'node_modules/@fixture/lib'))
  writePackage(root, 'node_modules/@fixture/lib', { name: '@fixture/lib', version: '1.0.0' })
  rmSync(join(root, 'node_modules/@babel/core'), { recursive: true })
  symlinkSync(join(root, 'packages/lib'), join(root, 'node_modules/@babel/core'), 'dir')
  const { differences } = findInstallDrift(root)
  assert.deepEqual(differences.map(d => [d.path, d.locked, d.installed.startsWith('link to ') ? 'link' : d.installed]), [
    ['node_modules/@babel/core', '7.29.13', 'link'],
    ['node_modules/@fixture/lib', 'link to packages/lib', 'a folder'],
  ])
})

test('a node_modules linked from another checkout is named in the message', t => {
  const root = checkout(t)
  const other = mkdtempSync(join(tmpdir(), 'check-install-lock-other-'))
  t.after(() => rmSync(other, { recursive: true, force: true }))
  // The other checkout's install, made for an older lockfile, and this checkout's link to it.
  writePackage(root, 'node_modules/@babel/core', { name: '@babel/core', version: '7.29.7' })
  renameSync(join(root, 'node_modules'), join(other, 'node_modules'))
  symlinkSync(join(other, 'node_modules'), join(root, 'node_modules'), 'dir')

  const result = findInstallDrift(root)
  assert.equal(result.problem, null)
  assert.equal(result.linkedTo, realpathSync(join(other, 'node_modules')))
  // The relative workspace link now points into the other checkout, which has no packages/lib.
  assert.deepEqual(result.differences, [
    { path: 'node_modules/@babel/core', locked: '7.29.13', installed: '7.29.7' },
    { path: 'node_modules/@fixture/lib', locked: 'link to packages/lib', installed: 'link to ../../packages/lib, which does not resolve' },
  ])

  const message = describeInstallDrift(result, root)
  assert.ok(message.includes(`node_modules here is a link to ${result.linkedTo},`), message)
  assert.match(message, /Remove the link itself \(not the folder it\s+points to\)/)

  rmSync(join(other, 'node_modules'), { recursive: true })
  assert.match(findInstallDrift(root).problem, /^node_modules is a link to .*, which does not exist\.$/)
})

test('a checkout without node_modules or without a readable lockfile is stopped, not passed', t => {
  const root = checkout(t)
  rmSync(join(root, 'node_modules'), { recursive: true })
  const missing = findInstallDrift(root)
  assert.equal(missing.problem, 'node_modules is missing: the dependencies are not installed.')
  const cli = runCli(root)
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /node_modules is missing/)
  assert.match(cli.stderr, /Install the locked dependencies/)

  rmSync(join(root, 'package-lock.json'))
  const noLock = findInstallDrift(root)
  assert.equal(noLock.lockUnreadable, true)
  assert.match(describeInstallDrift(noLock, root), /Restore package-lock\.json from the repository/)
  assert.equal(runCli(root).status, 1)

  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 1, dependencies: {} }))
  assert.match(findInstallDrift(root).problem, /no "packages" map/)
})

test('the message lists the first differences and counts the rest', t => {
  const root = checkout(t)
  for (let i = 0; i < 15; i++) writePackage(root, `node_modules/leftover-${String(i).padStart(2, '0')}`, { name: `leftover-${i}`, version: '1.0.0' })
  const message = describeInstallDrift(findInstallDrift(root), root)
  assert.match(message, /15 package paths differ from the lockfile:/)
  assert.match(message, /node_modules\/leftover-11 /)
  assert.doesNotMatch(message, /node_modules\/leftover-12 /)
  assert.match(message, /\.\.\. and 3 more/)
})
