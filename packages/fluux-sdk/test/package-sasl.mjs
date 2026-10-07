import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Install the distributable outside the monorepo: its dependency patches and
// workspace links must not supply authentication behavior to the consumer.
const sdk = fileURLToPath(new URL('..', import.meta.url))
const consumer = mkdtempSync(join(tmpdir(), 'fluux-sdk-consumer-'))
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run with npm run test:package after building the SDK')
const env = { ...process.env }
// npm forwards its workspace allow-list as a CLI-only setting to lifecycle
// scripts; a separate consumer uses its own installation policy.
delete env.npm_config_allow_scripts
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, env, encoding: 'utf8' })
try {
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', consumer], sdk))
  const filename = (Array.isArray(packed) ? packed[0] : Object.values(packed)[0]).filename
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', join(consumer, filename)], consumer)
  const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules/@fluux/sdk/package.json'), 'utf8'))
  assert.equal(manifest.name, '@fluux/sdk')
  writeFileSync(join(consumer, 'check.mjs'), `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    for (const sdk of [await import('@fluux/sdk/core'), createRequire(import.meta.url)('@fluux/sdk/core')]) {
      sdk.setLogSink(() => {});
      const owner = new sdk.XMPPClient();
      try {
        const xmpp = owner.connection.createXmppClient({
          jid: 'alice@example.test', password: 'secret', server: 'wss://example.test/ws',
        });
        for (const password of ['ascii', 'ô', 'Ł', 'o\\u0302', '🔑']) {
          const response = xmpp.saslFactory.create(['PLAIN']).response({ username: 'élise', password });
          assert.deepEqual(Buffer.from(btoa(response), 'base64'), Buffer.from('\\0élise\\0' + password, 'utf8'));
        }
        assert.equal(xmpp.saslFactory.create(['SCRAM-SHA-1']).name, 'SCRAM-SHA-1');
      } finally { owner.destroy(); }
    }
  `)
  execFileSync(process.execPath, ['check.mjs'], { cwd: consumer, stdio: 'inherit' })
  console.log('Packed SDK authenticates with UTF-8 PLAIN in ESM and CommonJS consumers')
} finally {
  rmSync(consumer, { recursive: true, force: true })
}
