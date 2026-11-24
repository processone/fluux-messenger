import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const launcher = fileURLToPath(new URL('./run.mjs', import.meta.url))

test('accepted preflight contract: missing executable fails instead of skipping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fluux-preflight-test-'))
  const missing = join(directory, 'fluux')
  try {
    await assert.rejects(exec(process.execPath, [launcher, '--preflight', '--app', missing]), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /ENOENT.*access/)
      assert.ok(error.stderr.includes(missing))
      return true
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
