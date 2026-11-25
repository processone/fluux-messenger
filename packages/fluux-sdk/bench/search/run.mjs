import { createServer, transformWithOxc } from 'vite'
import { chromium, webkit } from 'playwright'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const sourceHead = git('rev-parse', 'HEAD')
const baseline = process.env.BENCH_SEARCH_BASE ?? '15bc76f4b84fc40be695481c5736c8e9d750b234'
const baselineHead = git('rev-parse', '--verify', '--end-of-options', `${baseline}^{commit}`)
const historicalSource = execFileSync('git', ['show', `${baselineHead}:packages/fluux-sdk/src/utils/searchIndex.ts`], { cwd: root, encoding: 'utf8' })
if (!/const DB_VERSION = 5\b/.test(historicalSource)) throw new Error('BENCH_SEARCH_BASE must name an available version-5 index')
const baselineDigest = createHash('sha256').update(historicalSource).digest('hex')
const virtual = '\0search-index-v5.ts'
const checkOnly = process.argv.includes('--check')
const out = resolve(process.env.BENCH_SEARCH_OUTPUT ?? resolve(here, '../results/searchIndex.browser.json'))
const server = await createServer({
  root: here,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'search-benchmark-history',
    resolveId(source, importer) {
      if (source === 'virtual:search-index-v5') return virtual
      if (source === 'virtual:search-corpus') return resolve(root, 'apps/fluux/src/demo/conversations/index.ts')
      // Historical policy uses the same shipped helpers as the candidate, not a copied checkout.
      if (importer === virtual) return this.resolve(source, resolve(root, 'packages/fluux-sdk/src/utils/searchIndex.ts'), { skipSelf: true })
    },
    async load(id) {
      if (id === virtual) return transformWithOxc(historicalSource, 'searchIndex-v5.ts', { lang: 'ts' })
    },
  }],
})
const results = []
try {
  await server.listen()
  const url = server.resolvedUrls.local[0]
  for (const [name, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch()
    try {
      for (const variant of ['version5', 'candidate']) {
        const context = await browser.newContext()
        try {
          const page = await context.newPage()
          const errors = []
          page.on('pageerror', error => errors.push(String(error)))
          await page.goto(url)
          await page.waitForFunction(() => typeof window.runSearchBench === 'function')
          if (checkOnly) {
            const ready = await page.evaluate(() => window.checkSearchBench())
            results.push({ engine: name, variant, ...ready })
          } else {
            const result = await page.evaluate(variant => window.runSearchBench(variant), variant)
            if (result.count !== 50_000 || (variant === 'candidate' && (result.state.status !== 'usable' || result.facetRows === 0 ||
                result.reads.some(read => read.outOfSpan !== 0 || read.postingRows === 0 || read.resultIds.length === 0)))) {
              throw new Error(`Invalid search benchmark observations: ${JSON.stringify(result)}`)
            }
            results.push({ engine: name, ...result })
          }
          if (errors.length) throw new Error(errors.join('\n'))
        } finally { await context.close() }
      }
    } finally { await browser.close() }
  }
  const record = { sourceHead, dirty: git('status', '--porcelain').length > 0, baselineHead, baselineDigest, sharedPrimitivesHead: sourceHead, results }
  if (!checkOnly) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(record, null, 2) + '\n')
  }
  process.stdout.write(JSON.stringify({ checkOnly, ...record }, null, 2) + '\n')
} finally { await server.close() }
