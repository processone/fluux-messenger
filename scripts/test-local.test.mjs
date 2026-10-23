import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { checkRequirement, collectChanges, createPlan, executePlan, main, parseArgs, parseDiff, root } from './test-local.mjs'

// Intent: FLM-36 option B, requested for faster local iteration without omitting
// SDK consumers, native contracts, renamed/deleted files or explicit failure paths.
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
// These path lists come from git diff --name-only <commit>^ <commit> and work in shallow clones too.
const realChanges = JSON.parse(readFileSync(resolve(root, 'scripts/fixtures/local-test-changes.json'), 'utf8'))
const accessibility = realChanges['089f1239']
const photos = realChanges['dfb8d446']
const entries = paths => paths.map(path => ({ path, status: 'M' }))
const ids = plan => plan.steps.map(step => step.id)
const planFor = paths => createPlan(entries(paths))

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'fluux-test-local-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const write = (path, content = readFileSync(resolve(root, 'apps/fluux/src/i18n/locales/fr.json'))) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  git(cwd, 'init', '-q')
  git(cwd, 'config', 'user.name', 'Local policy test')
  git(cwd, 'config', 'user.email', 'local-policy@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'core.hooksPath', join(cwd, 'no-hooks'))
  write('apps/fluux/src/i18n/locales/fr.json')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-qm', 'test: initialize local policy fixture')
  return { cwd, write }
}

test('collector includes index, working tree, untracked and branch paths with spaces', t => {
  const { cwd, write } = fixture(t)
  const base = git(cwd, 'rev-parse', 'HEAD').trim()
  write('apps/fluux/src/i18n/locales/en.json', readFileSync(resolve(root, 'apps/fluux/src/i18n/locales/en.json')))
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-qm', 'test: add branch translation')
  const feature = git(cwd, 'symbolic-ref', '--short', 'HEAD').trim()
  git(cwd, 'checkout', '-qb', 'upstream-local', base)
  write('README.md', readFileSync(resolve(root, 'README.md')))
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-qm', 'test: advance the comparison branch')
  git(cwd, 'checkout', '-q', feature)
  write('staged translation.json')
  git(cwd, 'add', '.')
  write('apps/fluux/src/i18n/locales/fr.json', readFileSync(resolve(root, 'apps/fluux/src/i18n/locales/en.json')))
  write('new translation with spaces.json')
  assert.deepEqual(collectChanges({ cwd }).map(c => c.path).sort(), [
    'apps/fluux/src/i18n/locales/fr.json', 'new translation with spaces.json', 'staged translation.json',
  ].sort())
  const branch = collectChanges({ cwd, base: 'upstream-local' })
  assert.equal(branch.length, 4)
  assert.ok(!branch.some(c => c.path === 'README.md'), 'use the merge-base, not the comparison branch tip')
  assert.ok(branch.some(c => c.path.endsWith('/en.json')))
  // The working copy can undo an indexed edit; both transitions still belong to the scope.
  git(cwd, 'add', 'apps/fluux/src/i18n/locales/fr.json')
  write('apps/fluux/src/i18n/locales/fr.json')
  assert.equal(collectChanges({ cwd }).filter(c => c.path.endsWith('/fr.json')).length, 1)
  assert.throws(() => collectChanges({ cwd, base: 'missing-reference' }), /Git collection failed/)
  assert.throws(() => collectChanges({ cwd, base, paths: ['README.md'] }), /either/)
})

test('collector preserves rename endpoints, deleted paths, tabs and newlines', t => {
  const { cwd, write } = fixture(t)
  const old = 'apps/fluux/src/i18n/locales/fr.json'
  const destination = 'renamed translation\twith newline\n.json'
  renameSync(join(cwd, old), join(cwd, destination))
  git(cwd, 'add', '-A')
  const changed = collectChanges({ cwd })
  assert.deepEqual(changed.map(c => c.path).sort(), [old, destination].sort())
  assert.ok(changed.every(c => c.status === 'R'))
  git(cwd, 'commit', '-qm', 'test: rename translation')
  unlinkSync(join(cwd, destination))
  assert.deepEqual(collectChanges({ cwd }), [{ path: destination, status: 'D' }])
  write('new.json')
  assert.throws(() => collectChanges({ cwd, paths: ['../outside.ts'] }), /outside/)
  assert.throws(() => parseDiff('R100\0old\0'), /Incomplete/)
})

test('real accessibility change selects app imports, changed tests, languages and native wording, not SDK', () => {
  const plan = planFor(accessibility)
  assert.ok(ids(plan).includes('related:app'))
  assert.ok(!ids(plan).some(id => /sdk/i.test(id)))
  const selection = plan.steps.find(step => step.id === 'related:app')
  const changedTest = accessibility.find(path => path.endsWith('.test.tsx'))
  assert.ok(selection.direct.includes(resolve(root, changedTest)))
  assert.ok(selection.direct.includes(resolve(root, 'apps/fluux/src/i18n/i18n.test.ts')))
  const wording = plan.steps.find(step => step.args.includes('scripts/ios-notification-previews.test.mjs'))
  assert.ok(wording.args.includes('--test-name-pattern'))
})

test('real photo change keeps native suites and configuration/permission fallback', () => {
  const plan = planFor(photos)
  for (const id of ['test:ios-photos', 'test:ios-share', 'test:ios-extensions', 'test:ios-project', 'test:ios-generated-files', 'test:platform', 'full:app', 'full:sdk', 'check:tls-build']) {
    assert.ok(ids(plan).includes(id), id)
  }
  assert.ok(plan.steps.some(step => step.command === 'cargo' && step.args.includes('tauri-plugin-share-inbox')))
  assert.ok(plan.steps.some(step => step.command === 'cargo' && step.args.includes('production-tls')))
  assert.ok(!plan.steps.some(step => step.args.includes('test:parallel')))
  const permission = photos.find(path => path.includes('/permissions/') && path.endsWith('.md'))
  assert.ok(ids(planFor([permission])).includes('full:app'), 'generated permission documentation is not ordinary prose')
})

test('a changed test alone is planned and executed directly, without production discovery', () => {
  const path = accessibility.find(path => path.endsWith('.test.tsx'))
  const plan = planFor([path])
  const selection = plan.steps.find(step => step.kind === 'related')
  assert.deepEqual(selection.sources, [])
  assert.ok(selection.args.includes('run'))
  assert.ok(!selection.args.includes('related'))
  const calls = []
  executePlan(plan, { invoke(command, args, cwd, capture) { assert.ok(!capture); calls.push(args) } })
  assert.ok(calls.some(args => args.includes(resolve(root, path))))
})

test('ordinary SDK sources select both workspaces with the same absolute path and rebuild dist first', () => {
  const source = 'packages/fluux-sdk/src/utils/xmppUri.ts'
  const plan = planFor([source])
  assert.ok(ids(plan).indexOf('build:sdk') < ids(plan).indexOf('related:sdk'))
  const selections = plan.steps.filter(step => step.kind === 'related')
  assert.deepEqual(selections.map(step => step.workspace), ['sdk', 'app'])
  for (const step of selections) assert.deepEqual(step.sources, [resolve(root, source)])
})

test('shared SDK, exports, auth, persistence and connection changes retain full consumers and package contracts', () => {
  for (const path of ['packages/fluux-sdk/src/index.ts', 'packages/fluux-sdk/src/stores/chatStore.ts', 'packages/fluux-sdk/src/core/modules/Connection.ts', 'packages/fluux-sdk/src/cache/index.ts', 'packages/fluux-sdk/src/core/saslPlainUtf8.ts']) {
    const plan = planFor([path])
    for (const id of ['full:app', 'full:sdk', 'test:platform', 'test:package --workspace=@fluux/sdk']) assert.ok(ids(plan).includes(id), `${path}: ${id}`)
  }
})

test('Rust owners, plugins, NSE and TLS select whole crate suites and consumers', () => {
  const rust = planFor(['apps/fluux/src-tauri/src/xmpp_proxy/mod.rs'])
  assert.ok(rust.steps.some(step => step.command === 'cargo' && step.args.includes('production-tls')))
  assert.ok(ids(rust).includes('test:platform'))
  const plugin = planFor(['apps/fluux/src-tauri/plugins/share-inbox/src/inbox.rs'])
  assert.ok(plugin.steps.some(step => step.args.includes('tauri-plugin-share-inbox')))
  assert.ok(plugin.steps.some(step => step.command === 'cargo' && !step.args.includes('-p')))
  const nse = planFor(['apps/fluux/src-tauri/nse-openpgp/src/lib.rs'])
  assert.ok(nse.steps.some(step => step.args.includes('apps/fluux/src-tauri/nse-openpgp/Cargo.toml')))
  assert.ok(ids(nse).includes('test:ios-notifications'))
})

test('Swift and native test fixtures route to their runtime owner rather than Vitest alone', () => {
  for (const path of ['apps/fluux/src-tauri/plugins/share-inbox/ios/Sources/PhotoPreparation.swift', 'scripts/native-tests/PhotoPreparationTests.swift', 'scripts/ios-photo-reduction.test.mjs']) {
    assert.ok(ids(planFor([path])).includes('test:ios-photos'))
  }
  for (const path of ['apps/fluux/src-tauri/mobile/ios/ShareViewController.swift', 'scripts/native-tests/ios-share/ShareUITests.swift', 'scripts/native-tests/SharedURLTests.swift']) {
    const sharePlan = planFor([path])
    assert.ok(ids(sharePlan).includes('test:ios-share'))
    assert.ok(sharePlan.steps.some(step => step.args.includes('scripts/macos-share.test.mjs')))
  }
  for (const path of ['apps/fluux/src-tauri/mobile/ios/NotificationService.swift', 'scripts/native-tests/PreviewTokenTests.swift', 'scripts/native-tests/preview-identity-fixtures.json', 'tests/fixtures/notification-content.json', 'scripts/ios-notification-diagnostic.test.mjs']) {
    assert.ok(ids(planFor([path])).includes('test:ios-notifications'))
  }
  const diagnostic = planFor(['scripts/native-tests/ios-diagnostic/UITests.swift'])
  assert.ok(ids(diagnostic).includes('test:ios-diagnostic'))
  assert.ok(ids(diagnostic).includes('test:ios-notifications'))
})

test('deleted, renamed, setup, configs and unknown files widen explicitly; known prose does not', () => {
  const source = accessibility.find(path => path.endsWith('Settings.tsx'))
  for (const status of ['D', 'R']) assert.ok(ids(createPlan([{ path: source, status }])).includes('full:app'))
  for (const path of ['apps/fluux/vitest.config.ts', 'apps/fluux/vite.config.ts', 'tsconfig.base.json', 'package-lock.json', 'patches/@xmpp+sasl-plain+0.14.0.patch', 'unrecognised-runtime-file.dat']) {
    const plan = planFor([path])
    assert.ok(ids(plan).includes('full:app'), path)
    assert.ok(ids(plan).includes('full:sdk'), path)
  }
  assert.ok(ids(planFor(['apps/fluux/src/test-setup.ts'])).includes('full:app'))
  const docs = planFor(['docs/DEVELOPER.md', 'CONTRIBUTING.md'])
  assert.equal(docs.steps.length, 0)
  assert.ok(docs.notes.every(note => note.startsWith('Documentation only:')))
})

test('--list prints commands/reasons and cannot invoke a build, discovery or test child', t => {
  const { cwd, write } = fixture(t)
  write('package.json', readFileSync(resolve(root, 'package.json')))
  const output = []
  main(['--list', 'package.json'], { cwd, write: line => output.push(line), invoke() { assert.fail('dry run invoked a child') } })
  assert.ok(output.some(line => line.includes('cargo test --locked')))
  assert.ok(output.some(line => line.includes('Why:')))
  assert.throws(() => parseArgs(['--base']), /reference/)
  assert.throws(() => parseArgs(['--typo']), /Unknown/)
})

test('empty production selection widens, invalid selection and child failures stop execution', () => {
  const plan = planFor(['apps/fluux/src/utils/photoReduction.ts'])
  const calls = []
  const output = []
  executePlan(plan, { invoke(command, args) { calls.push([command, ...args]); return '[]' }, write: line => output.push(line) })
  assert.ok(calls.some(call => call.includes('test:run')))
  assert.ok(output.some(line => line.includes('widening')))
  assert.throws(() => executePlan(plan, { invoke() { return 'not json' } }), /Could not read/)
  assert.throws(() => executePlan(plan, { invoke() { return '[{}]' } }), /Invalid/)
  let children = 0
  assert.throws(() => executePlan(plan, { invoke() { children++; throw new Error('child failed') } }), /child failed/)
  assert.equal(children, 1)
})

test('nonempty selections run related tests and explicitly retain changed test files', () => {
  const plan = planFor(accessibility)
  const calls = []
  const unrelated = resolve(root, 'apps/fluux/src/components/ChatView.test.tsx')
  executePlan(plan, { invoke(command, args) { calls.push([command, ...args]); return JSON.stringify([unrelated]) }, write() {} })
  assert.ok(calls.some(call => call.includes('related') && call.includes('--run')))
  assert.ok(calls.some(call => call.includes(resolve(root, 'apps/fluux/src/i18n/i18n.test.ts')) && call.includes('run')))
})

test('native fixture gaps fail before work, including symlinked share output inside the project', t => {
  const { cwd } = fixture(t)
  const plan = planFor(['scripts/native-tests/PhotoPreparationTests.swift'])
  assert.throws(() => executePlan(plan, { env: {}, host: 'darwin', invoke() { assert.fail('work started before fixture check') } }), /FLUUX_PHOTO_FIXTURES/)
  assert.throws(() => checkRequirement('mac', cwd, {}, 'linux'), /skipped/)
  assert.throws(() => checkRequirement('share', cwd, { FLUUX_SHARE_RESULTS: cwd }, 'darwin'), /outside/)
  assert.throws(() => checkRequirement('diagnostic', cwd, {}, 'darwin'), /FLUUX_DIAGNOSTIC_RESULTS/)
  assert.throws(() => checkRequirement('diagnostic', cwd, { FLUUX_DIAGNOSTIC_RESULTS: cwd }, 'darwin'), /outside/)
  const link = join(cwd, 'result-link')
  symlinkSync(cwd, link, 'dir')
  assert.throws(() => checkRequirement('share', cwd, { FLUUX_SHARE_RESULTS: join(link, 'results') }, 'darwin'), /outside/)
})

test('real child exit codes fail the runner rather than reaching a later step', () => {
  const plan = { steps: [
    { command: process.execPath, args: ['-e', 'process.exit(23)'] },
    { command: process.execPath, args: ['-e', 'throw new Error("must not run")'] },
  ] }
  assert.throws(() => executePlan(plan), /failed \(23\)/)
})

test('CLI propagates Git errors rather than claiming no tests are needed', () => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/test-local.mjs'), '--list', '--base', 'missing-local-test-reference'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Git collection failed/)
  assert.doesNotMatch(result.stdout, /No tests selected/)
})

test('issue #1386 native prototype selects its executable contract tests', () => {
  for (const path of ['apps/fluux/src-tauri/macos/CommunicationNotification.m', 'apps/fluux/src-tauri/macos/CommunicationNotification.h', 'scripts/native-tests/MacCommunicationTests.m',
    'apps/fluux/src-tauri/src/notifications/macos.rs', 'apps/fluux/src-tauri/src/notifications/mod.rs', 'apps/fluux/src-tauri/src/notifications/backend.rs']) {
    const plan = planFor([path])
    assert.ok(plan.steps.some(step => step.args.includes('scripts/macos-communication.test.mjs')))
    assert.ok(plan.steps.some(step => step.command === 'cargo' && step.args.includes('macos-communication-prototype')))
    assert.ok(ids(plan).includes('test:platform'))
  }
})


test('FLM-99 R1: platform-specific notification edits do not require the macOS prototype', () => {
  for (const name of ['linux.rs', 'windows.rs', 'settings_pane.rs']) {
    const plan = planFor([`apps/fluux/src-tauri/src/notifications/${name}`])
    assert.ok(plan.steps.some(step => step.command === 'cargo'))
    assert.ok(ids(plan).includes('test:platform'))
    assert.ok(!plan.steps.some(step => step.requires === 'mac'))
    assert.ok(!plan.steps.some(step => step.args.includes('macos-communication-prototype')))
  }
})
