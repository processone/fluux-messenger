#!/usr/bin/env node
//
// Run both workspace test suites concurrently instead of in series.
//
// `npm test` runs the workspaces sequentially (SDK then app) — safe everywhere, and the
// default CI gate. On a multi-core dev machine the two suites can overlap: this runs them
// at the same time and reports a combined PASS/FAIL plus wall-clock time.
//
// Output from each workspace is line-prefixed ([sdk] / [app]) so the interleaved streams
// stay readable. Exit code is non-zero if either workspace fails.
//
import { spawn } from 'node:child_process'

const targets = [
  { tag: 'sdk', args: ['run', 'test:run', '-w', '@fluux/sdk'] },
  { tag: 'app', args: ['run', 'test:run', '-w', '@xmpp/fluux'] },
]

function run({ tag, args }) {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { shell: process.platform === 'win32' })
    const forward = (stream, out) => {
      let buf = ''
      stream.on('data', (chunk) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) out.write(`[${tag}] ${line}\n`)
      })
      stream.on('end', () => {
        if (buf) out.write(`[${tag}] ${buf}\n`)
      })
    }
    forward(child.stdout, process.stdout)
    forward(child.stderr, process.stderr)
    child.on('error', (err) => {
      process.stderr.write(`[${tag}] failed to spawn: ${err.message}\n`)
      resolve({ tag, code: 1 })
    })
    child.on('close', (code) => resolve({ tag, code: code ?? 1 }))
  })
}

const start = Date.now()
const results = await Promise.all(targets.map(run))
const seconds = ((Date.now() - start) / 1000).toFixed(1)

const bar = '='.repeat(48)
process.stdout.write(`\n${bar}\n`)
for (const r of results) {
  process.stdout.write(`  ${r.tag.padEnd(4)} ${r.code === 0 ? 'PASS' : `FAIL (exit ${r.code})`}\n`)
}
process.stdout.write(`  wall time: ${seconds}s\n${bar}\n`)

process.exit(results.some((r) => r.code !== 0) ? 1 : 0)
