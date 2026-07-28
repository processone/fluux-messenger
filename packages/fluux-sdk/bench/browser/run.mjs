/**
 * Playwright driver for the browser half of the #1138 persistence benchmark.
 *
 * Starts a Vite dev server over `bench/browser`, loads the page in Chromium and
 * WebKit, and runs every scenario. WebKit is the one that matters: it is the
 * engine behind the iOS/macOS WebView and the Linux WebKitGTK build, and its
 * `localStorage.setItem` is a synchronous disk write.
 *
 * Run: `npm run bench:persist:browser -w @fluux/sdk`
 */

import { createServer } from 'vite'
import { chromium, webkit } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SPACING_MS = Number(process.env.BENCH_SPACING_MS ?? 25)

const server = await createServer({
  root: here,
  configFile: false,
  server: { port: 0 },
  // The bench imports the SDK's own sources, which live above `root`.
  resolve: { preserveSymlinks: false },
})
await server.listen()
const url = server.resolvedUrls.local[0]

const results = []
const probes = []

for (const [name, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await launcher.launch()
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => typeof window.runBench === 'function', null, { timeout: 30_000 })
  const { rows, probe } = await page.evaluate((spacing) => window.runBench(spacing), SPACING_MS)
  for (const row of rows) {
    results.push({
      engine: name,
      spacingMs: SPACING_MS,
      ...row,
      // Quantization-free total: per-write cost from a timed batch, times the
      // writes this rule actually performed. See main.ts's writeCostProbe.
      probedBlockMs: Number((probe.perWriteMs * row.writes).toFixed(1)),
      perWriteMs: probe.perWriteMs,
    })
  }
  probes.push({ engine: name, ...probe })
  if (errors.length) {
    process.stderr.write(`\n[${name}] page errors:\n${errors.join('\n')}\n`)
  }
  await browser.close()
}

await server.close()

const out = resolve(here, '../results/persistCost.browser.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(results, null, 2))

const header =
  `  ${'engine'.padEnd(10)}${'scenario'.padEnd(22)}${'muts'.padStart(6)}${'writes'.padStart(8)}` +
  `${'MB'.padStart(9)}${'probedMs'.padStart(10)}${'blockedMs'.padStart(11)}` +
  `${'maxMut'.padStart(9)}${'>50ms'.padStart(7)}`
const lines = [
  '',
  '='.repeat(header.length),
  `BROWSER PERSISTENCE COST — issue #1138 (spacing ${SPACING_MS}ms, blob ${(results[0]?.blobBytes ?? 0) / 1024 | 0} KB)`,
  '='.repeat(header.length),
  `  per-write cost (timed 50-write batch): ${probes.map((p) => `${p.engine} ${p.perWriteMs}ms`).join(', ')}`,
  '',
  header,
]
for (const r of results) {
  lines.push(
    `  ${r.engine.padEnd(10)}${r.scenario.padEnd(22)}${String(r.mutations).padStart(6)}` +
    `${String(r.writes).padStart(8)}${(r.bytes / 1048576).toFixed(2).padStart(9)}` +
    `${r.probedBlockMs.toFixed(1).padStart(10)}${r.blockedMs.toFixed(1).padStart(11)}` +
    `${r.maxMutationMs.toFixed(2).padStart(9)}${String(r.longTasks).padStart(7)}`,
  )
}
lines.push('')
lines.push('  probedMs = per-write cost x writes (quantization-free; the number to compare)')
lines.push('  blockedMs = summed per-mutation deltas (Chromium reliable; WebKit quantizes performance.now to 1ms)')
lines.push('')
process.stdout.write(`${lines.join('\n')}\n`)
