import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { retargetExtensions, withExtensionsUnder } from '../apps/fluux/scripts/ios-extension-identifiers.mjs'

const prod = 'net.processone.fluux'
const demo = 'net.processone.fluux.demo'
const targets = ['fluux_iOS', 'FluuxShare', 'FluuxNotification', 'FluuxWidgets']
const app = fileURLToPath(new URL('../apps/fluux/', import.meta.url))
const project = (app, extensions) => [
  `PRODUCT_BUNDLE_IDENTIFIER = ${app};`,
  `PRODUCT_BUNDLE_IDENTIFIER = ${extensions}.share;`,
  `PRODUCT_BUNDLE_IDENTIFIER = ${extensions}.notification;`,
  `PRODUCT_BUNDLE_IDENTIFIER = ${extensions}.widgets;`,
].join('\n')

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-ios-extensions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function metadataPaths(dir) {
  return targets.flatMap(target => [join(dir, target, 'Info.plist'), join(dir, target, `${target}.entitlements`)])
}

function fixture(t) {
  const dir = scratch(t)
  const pbx = join(dir, 'fluux.xcodeproj', 'project.pbxproj')
  mkdirSync(join(dir, 'fluux.xcodeproj'))
  writeFileSync(pbx, project(prod, prod))
  for (const target of targets) {
    mkdirSync(join(dir, target))
    // Include all identity-shaped values emitted by XcodeGen, plus unrelated negative controls.
    const strings = [prod, `group.${prod}.share`, `$(AppIdentifierPrefix)${prod}`,
      `$(AppIdentifierPrefix)${prod}.notification`, `$(AppIdentifierPrefix)${prod}.notification-preview`,
      'xmpp', `https://${prod}/help`, `group.${prod}.unrelated`, `$(AppIdentifierPrefix)${prod}.other`]
    const xml = `<?xml version="1.0"?><plist version="1.0"><array>${strings.map(s => `<string>${s}</string>`).join('')}</array></plist>\n`
    writeFileSync(join(dir, target, 'Info.plist'), xml)
    writeFileSync(join(dir, target, `${target}.entitlements`), xml)
  }
  return { dir, pbx, saved: new Map(metadataPaths(dir).map(path => [path, readFileSync(path)])) }
}

function assertRetargeted(saved, identifier) {
  for (const [path, contents] of saved) {
    const expected = contents.toString().replaceAll(`<string>${prod}</string>`, `<string>${identifier}</string>`)
      .replaceAll(`<string>group.${prod}.share</string>`, `<string>group.${identifier}.share</string>`)
      .replaceAll(`<string>$(AppIdentifierPrefix)${prod}</string>`, `<string>$(AppIdentifierPrefix)${identifier}</string>`)
      .replaceAll(`<string>$(AppIdentifierPrefix)${prod}.notification</string>`, `<string>$(AppIdentifierPrefix)${identifier}.notification</string>`)
      .replaceAll(`<string>$(AppIdentifierPrefix)${prod}.notification-preview</string>`, `<string>$(AppIdentifierPrefix)${identifier}.notification-preview</string>`)
    assert.equal(readFileSync(path, 'utf8'), expected, path)
  }
}

function assertRestored(saved) {
  for (const [path, contents] of saved) assert.deepEqual(readFileSync(path), contents, path)
}

test('moves only the extension identifiers', () => {
  assert.equal(retargetExtensions(project(demo, prod), prod, demo), project(demo, demo))
})

test('retargets all four targets during a build and restores their original metadata bytes', t => {
  const { pbx, saved } = fixture(t)
  const result = withExtensionsUnder(pbx, prod, demo, () => {
    assert.equal(readFileSync(pbx, 'utf8'), project(prod, demo))
    assertRetargeted(saved, demo)
    // Tauri updates the app target and may rewrite generated plists during a build.
    writeFileSync(pbx, project(demo, demo))
    for (const path of saved.keys()) writeFileSync(path, readFileSync(path, 'utf8') + '<!-- build edit -->\n')
    return 'built'
  })
  assert.equal(result, 'built')
  assert.equal(readFileSync(pbx, 'utf8'), project(demo, prod))
  assertRestored(saved)
})

test('restores all metadata after a failed build, then supports demo and regular builds again', t => {
  const { pbx, saved } = fixture(t)
  assert.throws(() => withExtensionsUnder(pbx, prod, demo, () => {
    assertRetargeted(saved, demo)
    for (const path of saved.keys()) writeFileSync(path, 'rewritten by failed build')
    throw new Error('build failed')
  }), /build failed/)
  assert.equal(readFileSync(pbx, 'utf8'), project(prod, prod))
  assertRestored(saved)
  withExtensionsUnder(pbx, prod, demo, () => assertRetargeted(saved, demo))
  assertRestored(saved)
  withExtensionsUnder(pbx, prod, prod, () => {
    assert.equal(readFileSync(pbx, 'utf8'), project(prod, prod))
    assertRestored(saved)
  })
})

test('restores metadata when the build returns a failed process result without throwing', t => {
  const { pbx, saved } = fixture(t)
  const failure = { status: 1, error: undefined }
  assert.equal(withExtensionsUnder(pbx, prod, demo, () => {
    assertRetargeted(saved, demo)
    return failure
  }), failure)
  assert.equal(readFileSync(pbx, 'utf8'), project(prod, prod))
  assertRestored(saved)
})

test('leaves a regular build untouched and preserves the callback result', t => {
  const { pbx, saved } = fixture(t)
  assert.equal(withExtensionsUnder(pbx, prod, prod, () => {
    assert.equal(readFileSync(pbx, 'utf8'), project(prod, prod))
    assertRestored(saved)
    return 'regular build'
  }), 'regular build')
})

test('reads every required metadata file before changing the project or starting the build', t => {
  const { pbx, saved } = fixture(t)
  const missing = [...saved.keys()].at(-1)
  rmSync(missing)
  saved.delete(missing)
  let built = false
  assert.throws(() => withExtensionsUnder(pbx, prod, demo, () => { built = true }), /ENOENT/)
  assert.equal(built, false)
  assert.equal(readFileSync(pbx, 'utf8'), project(prod, prod))
  assertRestored(saved)
})

function templateBlock(target, key) {
  const start = target.indexOf(`    ${key}:\n`)
  assert.notEqual(start, -1, key)
  const rest = target.slice(start + `    ${key}:\n`.length)
  const end = rest.search(/^    \S/m)
  return `    ${key}:\n${end === -1 ? rest : rest.slice(0, end)}`
}

function generateMetadata(dir) {
  const template = readFileSync(join(app, 'src-tauri/mobile/ios/project.yml'), 'utf8')
  const version = JSON.parse(readFileSync(join(app, 'src-tauri/tauri.conf.json'))).version
  const names = ['{{app.name}}_iOS', ...targets.slice(1)]
  let spec = 'name: fluux\ntargets:\n'
  for (const [index, name] of names.entries()) {
    const start = template.indexOf(`  ${name}:\n`)
    assert.notEqual(start, -1, name)
    const rest = template.slice(start + `  ${name}:\n`.length)
    const end = rest.search(/^  \S/m)
    const target = end === -1 ? rest : rest.slice(0, end)
    const identifier = prod + ['', '.share', '.notification', '.widgets'][index]
    const metadata = (templateBlock(target, 'info') + templateBlock(target, 'entitlements'))
      .replaceAll('{{app.name}}', 'fluux').replaceAll('{{app.identifier}}', prod)
      .replaceAll('{{apple.bundle-version-short}}', version).replaceAll('{{apple.bundle-version}}', '1')
      .replace(/        {{~#each apple\.plist-pairs}}[^]*?{{\/each}}\n/, '')
    assert.ok(!metadata.includes('{{'), `Render all metadata fields for ${name}`)
    spec += `  ${targets[index]}:\n    type: ${index === 0 ? 'application' : 'app-extension'}\n    platform: iOS\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: ${identifier}\n${metadata}`
  }
  writeFileSync(join(dir, 'project.yml'), spec)
  execFileSync('xcodegen', ['generate', '--spec', join(dir, 'project.yml')], { cwd: dir, timeout: 120000 })
}

function plist(path) {
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }))
}

function assertGeneratedProject(dir, appIdentifier, extensionIdentifier) {
  const { objects } = plist(join(dir, 'fluux.xcodeproj/project.pbxproj'))
  const nativeTargets = Object.values(objects).filter(object => object.isa === 'PBXNativeTarget')
  assert.deepEqual(nativeTargets.map(target => target.name).sort(), [...targets].sort())
  for (const target of nativeTargets) {
    const index = targets.indexOf(target.name)
    const identifier = index === 0 ? appIdentifier : extensionIdentifier + ['', '.share', '.notification', '.widgets'][index]
    for (const config of objects[target.buildConfigurationList].buildConfigurations) {
      const settings = objects[config].buildSettings
      assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, identifier, target.name)
      assert.equal(settings.INFOPLIST_FILE, `${target.name}/Info.plist`)
      assert.equal(settings.CODE_SIGN_ENTITLEMENTS, `${target.name}/${target.name}.entitlements`)
    }
  }
}

function assertGeneratedMetadata(dir, identifier) {
  for (const [index, target] of targets.entries()) {
    const info = plist(join(dir, target, 'Info.plist'))
    const ent = plist(join(dir, target, `${target}.entitlements`))
    assert.equal(info.FluuxShareGroup, `group.${identifier}.share`, `${target} lookup group`)
    assert.deepEqual(ent['com.apple.security.application-groups'], [info.FluuxShareGroup], `${target} authorized group`)
    if (index === 0 || target === 'FluuxNotification') {
      assert.equal(info.FluuxPreviewKeychainGroup, `$(AppIdentifierPrefix)${identifier}.notification-preview`)
      assert.deepEqual(ent['keychain-access-groups'], [
        `$(AppIdentifierPrefix)${identifier}${index === 0 ? '' : '.notification'}`, info.FluuxPreviewKeychainGroup,
      ])
    } else {
      assert.equal(info.FluuxPreviewKeychainGroup, undefined, `${target} has no preview capability`)
      assert.equal(ent['keychain-access-groups'], undefined, `${target} has no shared secrets entitlement`)
    }
    if (target !== 'FluuxNotification') assert.equal(info.FluuxAppScheme, identifier)
    if (index === 0) {
      assert.deepEqual(info.CFBundleURLTypes, [{ CFBundleURLName: identifier, CFBundleURLSchemes: ['xmpp', identifier] }])
      assert.equal(ent['aps-environment'], 'development')
      assert.equal(ent['com.apple.developer.usernotifications.communication'], true)
    }
  }
}

test('real XcodeGen metadata isolates demo groups and links across successful and failed builds', { skip: process.platform !== 'darwin' }, t => {
  const dir = scratch(t)
  generateMetadata(dir)
  const pbx = join(dir, 'fluux.xcodeproj/project.pbxproj')
  const saved = new Map(metadataPaths(dir).map(path => [path, readFileSync(path)]))
  assertGeneratedMetadata(dir, prod)
  assertGeneratedProject(dir, prod, prod)
  for (const failed of [false, true]) {
    const build = () => withExtensionsUnder(pbx, prod, demo, () => {
      assertGeneratedProject(dir, prod, demo)
      assertGeneratedMetadata(dir, demo)
      if (failed) throw new Error('unsigned build failed')
      return 'unsigned metadata accepted'
    })
    if (failed) assert.throws(build, /unsigned build failed/)
    else assert.equal(build(), 'unsigned metadata accepted')
    assertRestored(saved)
    withExtensionsUnder(pbx, prod, prod, () => {
      assertGeneratedMetadata(dir, prod)
      assertGeneratedProject(dir, prod, prod)
    })
  }
})
