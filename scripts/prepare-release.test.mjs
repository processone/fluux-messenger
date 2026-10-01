import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const changelogFile = 'apps/fluux/src/data/changelog.ts'

for (const { version, date, tag = false } of [
  { version: '0.18.0', date: 'Unreleased' },
  { version: '0.18.0-beta.1', date: 'Unreleased' },
  { version: '0.18.0', date: 'Unreleased', tag: true },
  { version: '0.18.0-beta.1', date: 'Unreleased', tag: true },
  { version: '0.18.0', date: ' Unreleased ' },
  { version: '0.18.0', date: '2026-09-15' },
  { version: '0.18.0-beta.1', date: '2026-09-15' },
]) {
  const isDraft = date.trim() === 'Unreleased'
  test(`release preparation ${isDraft ? 'rejects' : 'preserves'} ${date} for ${version}${tag ? ' with --tag' : ''}`, async (t) => {
    const fixture = mkdtempSync(join(root, '.prepare-release-test-'))
    t.after(() => rmSync(fixture, { recursive: true, force: true }))
    const inputs = new Map()
    const write = (file, content) => {
      const target = join(fixture, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      inputs.set(file, content)
    }
    const read = (file) => readFileSync(join(fixture, file), 'utf8')
    const entry = (entryVersion, entryDate) => `{
      version: '${entryVersion}',
      date: '${entryDate}',
      sections: [{ type: 'fixed', items: ['Fix for ${entryVersion}'] }],
    }`

    for (const file of ['package.json', 'apps/fluux/package.json', 'packages/fluux-sdk/package.json']) {
      write(file, JSON.stringify({ type: 'module', version: '0.17.4' }))
    }
    write(changelogFile, `export const changelog = [
      ${entry('0.19.0', 'Unreleased')},
      ${entry('0.18.0', date)},
      ${entry('0.17.4', '2026-09-15')},
    ]`)
    write('packages/fluux-sdk/src/version.ts', "export const SDK_VERSION = '0.17.4'\n")
    write('apps/fluux/src-tauri/tauri.conf.json', JSON.stringify({
      version: '0.17.4',
      bundle: { macOS: { bundleVersion: '0.17.4' }, createUpdaterArtifacts: true },
    }))
    write('apps/fluux/src-tauri/Cargo.toml', '[package]\nversion = "0.17.4"\n')
    write('packaging/debian/changelog', 'fluux-messenger (0.17.4-1) unstable; urgency=medium\n\n -- Maintainer  Tue, 15 Sep 2026 12:00:00 +0000\n')
    write('packaging/flatpak/net.processone.fluux.metainfo.xml', '<component>\n  <releases>\n  </releases>\n</component>\n')
    write('fluux-messenger.doap', '<Project>\n  <!-- Releases -->\n</Project>\n')
    write('isolate-toolchain.mjs', `
      import childProcess from 'node:child_process'
      import { appendFileSync } from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      childProcess.execSync = (command) => {
        appendFileSync(new URL('./toolchain-calls', import.meta.url), command)
        if (!['npm install --package-lock-only', 'cargo check'].includes(command)) {
          throw new Error('Unexpected command: ' + command)
        }
        return ''
      }
      syncBuiltinESMExports()
    `)
    mkdirSync(join(fixture, 'scripts'))
    copyFileSync(join(root, 'scripts/prepare-release.js'), join(fixture, 'scripts/prepare-release.js'))

    const run = () => spawnSync(process.execPath, [
      '--import', join(fixture, 'isolate-toolchain.mjs'),
      join(fixture, 'scripts/prepare-release.js'), version,
      ...(tag ? ['--tag'] : []),
    ], { cwd: fixture, encoding: 'utf8' })
    const result = run()
    if (isDraft) {
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.ok(result.stderr.includes(`Cannot prepare v${version}`))
      assert.ok(result.stderr.includes('set the real release date (YYYY-MM-DD) by hand for v0.18.0'))
      assert.ok(result.stderr.includes(changelogFile))
      for (const [file, content] of inputs) {
        assert.equal(read(file), content, `${file} must remain unchanged`)
      }
      for (const file of ['CHANGELOG.md', 'RELEASE_NOTES.md', 'toolchain-calls']) {
        assert.equal(existsSync(join(fixture, file)), false, `${file} must not be created`)
      }
      return
    }
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(result.stderr, '')

    const { changelog } = await import(pathToFileURL(join(fixture, changelogFile)).href)
    const releaseDate = changelog.find((entry) => entry.version === '0.18.0').date
    assert.equal(releaseDate, date)
    assert.equal(changelog.find((entry) => entry.version === '0.19.0').date, 'Unreleased')
    assert.equal(changelog.find((entry) => entry.version === '0.17.4').date, '2026-09-15')
    assert.ok(read('CHANGELOG.md').includes(`## [0.18.0] - ${releaseDate}\n`))
    assert.ok(read('CHANGELOG.md').includes('## [0.19.0] - Unreleased\n'))
    assert.ok(read('RELEASE_NOTES.md').includes('Fix for 0.18.0'))
    assert.ok(!read('RELEASE_NOTES.md').includes('Fix for 0.19.0'))
    const debDate = new Date(`${releaseDate}T12:00:00Z`).toUTCString().replace('GMT', '+0000')
    assert.ok(read('packaging/debian/changelog').includes(`  ${debDate}\n`))
    assert.ok(read('packaging/flatpak/net.processone.fluux.metainfo.xml').includes(`<release version="0.18.0" date="${releaseDate}">`))
    assert.ok(read('fluux-messenger.doap').includes(`<created>${releaseDate}</created>`))

    const firstChangelog = changelog
    const firstMarkdown = read('CHANGELOG.md')
    const repeated = run()
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout)
    assert.equal(repeated.stderr, '')
    const rerun = await import(`${pathToFileURL(join(fixture, changelogFile)).href}?rerun`)
    assert.deepEqual(rerun.changelog, firstChangelog)
    assert.equal(read('CHANGELOG.md'), firstMarkdown)
  })
}
