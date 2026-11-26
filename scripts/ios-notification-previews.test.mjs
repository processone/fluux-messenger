import { generatedIdentityCorpus } from './native-tests/preview-identity-generated.mjs'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
      ...['PreviewResult.swift', 'PreviewLedger.swift', 'PreviewTrace.swift'].map(name => fileURLToPath(new URL(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationPreviews/${name}`, import.meta.url))),
      fileURLToPath(new URL('./native-tests/NotificationPreviewTests.swift', import.meta.url)), '-lsqlite3', '-o', binary], { timeout: 120000 })
    assert.match(execFileSync(binary, [], { timeout: 60000 }).toString(), /passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('shared ID ledger lifecycle, metadata and races', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-ledger-test-'))
  const binary = join(scratch, 'ledger-tests')
  try {
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', join(scratch, 'cache'),
      ...['PreviewResult.swift', 'PreviewLedger.swift'].map(name => fileURLToPath(new URL(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationPreviews/${name}`, import.meta.url))),
      fileURLToPath(new URL('./native-tests/PreviewLedgerTests.swift', import.meta.url)), '-lsqlite3', '-o', binary], { timeout: 120000 })
    assert.match(execFileSync(binary, [fileURLToPath(new URL('./native-tests/preview-identity-fixtures.json', import.meta.url))], { timeout: 60000 }).toString(), /passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
test('deterministic SDK, Rust and Swift identity differential oracle', { skip: process.platform !== 'darwin' }, () => {
  const corpus = generatedIdentityCorpus()
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-identity-oracle-'))
  try {
    // Hand this ~200 KB corpus to children as files, never through execFileSync's `input`: on macOS
    // that pipe intermittently deadlocks, the SDK oracle blocked in read() on stdin and this process
    // waiting in spawnSync with no data queued on either side, until the job's time limit.
    const corpusPath = join(scratch, 'corpus.json')
    writeFileSync(corpusPath, JSON.stringify(corpus))
    // Each child opens its own descriptor: a shared one would leave the next child at end of file.
    const readingCorpus = (file, args, options) => {
      const stdin = openSync(corpusPath, 'r')
      try { return execFileSync(file, args, { ...options, encoding: 'utf8', stdio: [stdin, 'pipe', 'inherit'] }) } finally { closeSync(stdin) }
    }
    const expected = JSON.parse(readingCorpus(process.execPath, ['--experimental-strip-types', '--loader', fileURLToPath(new URL('./native-tests/sdk-ts-loader.mjs', import.meta.url)), fileURLToPath(new URL('./native-tests/preview-identity-oracle.mjs', import.meta.url))], { timeout: 60000 }))
    const prebuiltOracle = process.env.FLUUX_PREVIEW_IDENTITY_ORACLE
    const rustOutput = prebuiltOracle === undefined
      ? readingCorpus('cargo', ['run', '--locked', '--manifest-path', fileURLToPath(new URL('../apps/fluux/src-tauri/nse-openpgp/Cargo.toml', import.meta.url)), '--features', 'synthetic-lab', '--example', 'identity_oracle'], { timeout: 120000 })
      : readingCorpus(prebuiltOracle, [], { timeout: 120000 })
    const actual = JSON.parse(rustOutput)
    assert.deepEqual(actual, expected)
    corpus.cases.forEach((test, index) => {
      test.resolved = expected[index].resolved
      if (test.batches) test.steps = expected[index].steps
      test.messages.forEach((message, i) => {
        message.uid = message.mamUid ?? (message.stanzaBy === message.account ? message.stanzaId : '')
        message.key = expected[index].keys[i]
      })
    })
    const resolvedCorpusPath = join(scratch, 'resolved-corpus.json')
    writeFileSync(resolvedCorpusPath, JSON.stringify(corpus))
    const binary = join(scratch, 'ledger-tests')
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', join(scratch, 'cache'),
      ...['PreviewResult.swift', 'PreviewLedger.swift'].map(name => fileURLToPath(new URL(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationPreviews/${name}`, import.meta.url))),
      fileURLToPath(new URL('./native-tests/PreviewLedgerTests.swift', import.meta.url)), '-lsqlite3', '-o', binary], { timeout: 120000 })
    assert.match(execFileSync(binary, [resolvedCorpusPath], { timeout: 60000 }).toString(), /passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
test('native notification wording matches every i18n locale', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../apps/fluux/scripts/mobile-share-resources.mjs', import.meta.url))], { timeout: 60000 })
  const locales = new URL('../apps/fluux/src/i18n/locales/', import.meta.url)
  for (const file of readdirSync(locales).filter(name => name.endsWith('.json'))) {
    const expected = JSON.parse(readFileSync(new URL(file, locales), 'utf8')).notificationPreview
    const locale = file.slice(0, -5) === 'zh-CN' ? 'zh-Hans' : file.slice(0, -5)
    const output = readFileSync(new URL(`../apps/fluux/src-tauri/mobile/ios/AppResources/${locale}.lproj/NotificationPreviews.strings`, import.meta.url), 'utf8')
    const actual = Object.fromEntries(output.trim().split('\n').map(line => {
      const [key, value] = line.slice(0, -1).split(' = ')
      return [JSON.parse(key), JSON.parse(value)]
    }))
    assert.deepEqual(actual, expected)
  }
})
