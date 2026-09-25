import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fixture(t, initialized = true) {
  const root = mkdtempSync(resolve(tmpdir(), 'fluux-ios-icons-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const app = resolve(root, 'apps/fluux')
  const native = resolve(app, 'src-tauri')
  mkdirSync(resolve(app, 'scripts'), { recursive: true })
  mkdirSync(resolve(root, 'scripts'), { recursive: true })
  cpSync(resolve(repo, 'apps/fluux/package.json'), resolve(app, 'package.json'))
  cpSync(resolve(repo, 'apps/fluux/src-tauri/icons'), resolve(native, 'icons'), { recursive: true })
  cpSync(resolve(repo, 'scripts/select-icon-variant.mjs'), resolve(root, 'scripts/select-icon-variant.mjs'))
  cpSync(resolve(repo, 'apps/fluux/scripts/mobile-share-resources.mjs'), resolve(app, 'scripts/mobile-share-resources.mjs'))
  cpSync(resolve(repo, 'apps/fluux/src/i18n/locales'), resolve(app, 'src/i18n/locales'), { recursive: true })
  const generator = 'apps/fluux/scripts/tauri-ios-icons.mjs'
  if (existsSync(resolve(repo, generator))) cpSync(resolve(repo, generator), resolve(root, generator))
  const entrypoint = 'apps/fluux/scripts/tauri.mjs'
  if (existsSync(resolve(repo, entrypoint))) cpSync(resolve(repo, entrypoint), resolve(root, entrypoint))
  symlinkSync(resolve(repo, 'node_modules'), resolve(root, 'node_modules'), 'dir')
  const catalog = resolve(native, 'gen/apple/Assets.xcassets/AppIcon.appiconset')
  if (initialized) {
    mkdirSync(catalog, { recursive: true })
    writeFileSync(resolve(catalog, 'Contents.json'), '{"fixture":"preserve catalog metadata"}\n')
    writeFileSync(resolve(catalog, 'AppIcon-512@2x.png'), 'default template icon')
  }
  // A future Android project must not be touched by iOS icon preparation.
  const android = resolve(native, 'gen/android/app/src/main/res')
  mkdirSync(android, { recursive: true })
  writeFileSync(resolve(android, 'sentinel.txt'), 'android assets')
  return { app, native, catalog, android }
}

for (const style of ['hollow', 'plain']) {
  test(`iOS preparation replaces the template icon using ${style}, preserving other targets`, t => {
    const { app, native, catalog, android } = fixture(t)
    execFileSync('npm', ['run', 'tauri:ios:icons', '--if-present'], {
      cwd: app, env: { ...process.env, VITE_FLUUX_ICON_STYLE: style }, stdio: 'pipe',
    })
    const icon = readFileSync(resolve(catalog, 'AppIcon-512@2x.png'))
    assert.notEqual(icon.toString(), 'default template icon', 'the Xcode catalog must receive the Fluux icon')
    const expected = resolve(native, `icons/icon-variants/${style}/dist/icons`)
    const names = readdirSync(resolve(expected, 'ios')).filter(name => name.endsWith('.png'))
    for (const name of names) {
      const png = readFileSync(resolve(catalog, name))
      const reference = readFileSync(resolve(expected, 'ios', name))
      assert.equal(png.subarray(1, 4).toString(), 'PNG')
      assert.equal(png.readUInt32BE(16), reference.readUInt32BE(16), `${name} width`)
      assert.equal(png.readUInt32BE(20), reference.readUInt32BE(20), `${name} height`)
    }
    assert.deepEqual(readFileSync(resolve(native, 'icons/icon.icns')), readFileSync(resolve(expected, 'icon.icns')))
    assert.deepEqual(readdirSync(android), ['sentinel.txt'])
    assert.equal(readFileSync(resolve(catalog, 'Contents.json'), 'utf8'), '{"fixture":"preserve catalog metadata"}\n')
  })
}

test('iOS preparation requires initialization rather than silently leaving default assets', t => {
  const { app } = fixture(t, false)
  assert.throws(() => execFileSync('npm', ['run', 'tauri:ios:icons', '--if-present'], {
    cwd: app, stdio: 'pipe',
  }), error => /tauri:ios:init/.test(error.stderr?.toString() ?? ''))
})

test('the npm entrypoint used by Xcode replaces the template before invoking Tauri', t => {
  const { app, catalog } = fixture(t)
  // Help avoids compiling Rust while exercising the generated Xcode command's entrypoint.
  execFileSync('npm', ['run', '--', 'tauri', 'ios', 'xcode-script', '--help'], {
    cwd: app, stdio: 'pipe',
  })
  const icon = readFileSync(resolve(catalog, 'AppIcon-512@2x.png'))
  assert.notEqual(icon.toString(), 'default template icon', 'direct Xcode builds must prepare the icon')
  assert.equal(icon.subarray(1, 4).toString(), 'PNG')
})

test('ordinary Tauri commands work without an initialized iOS project', t => {
  const { app, native } = fixture(t, false)
  const output = execFileSync('npm', ['run', '--', 'tauri', '--version'], {
    cwd: app, encoding: 'utf8', stdio: 'pipe',
  })
  assert.match(output, /tauri-cli \d+\./)
  assert.equal(existsSync(resolve(native, 'gen/apple')), false)
})

test('the Xcode entrypoint stops if icon preparation cannot complete', t => {
  const { app } = fixture(t, false)
  assert.throws(() => execFileSync('npm', ['run', '--', 'tauri', 'ios', 'xcode-script', '--help'], {
    cwd: app, stdio: 'pipe',
  }), error => error.status !== 0 && /tauri:ios:init/.test(error.stderr?.toString() ?? ''))
})

test('the wrapper preserves Tauri command failures', t => {
  const { app } = fixture(t, false)
  assert.throws(() => execFileSync('npm', ['run', '--', 'tauri', 'invalid-fluux-command'], {
    cwd: app, stdio: 'pipe',
  }), error => error.status !== 0 && /invalid-fluux-command/.test(error.stderr?.toString() ?? ''))
})
