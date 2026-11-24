import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const app = process.env.FLUUX_SEARCH_PROOF_APP
const output = process.env.FLUUX_SEARCH_PROOF_OUTPUT
if (!app || !output) throw new Error('Set FLUUX_SEARCH_PROOF_APP and FLUUX_SEARCH_PROOF_OUTPUT')
const host = new URL(app).hostname
if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error('Search proof requires a disposable loopback app')
const relative = path.relative(process.cwd(), path.resolve(output))
if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Proof output must stay outside the working copy')
const stage = process.env.FLUUX_SEARCH_PROOF_STAGE ?? 'candidate'
if (!['candidate', 'version5'].includes(stage)) throw new Error('Unknown search proof stage')
const browser = await chromium.launch()
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(app)
  const fixture = `/@fs/${process.cwd()}/packages/fluux-sdk/src/utils/fixtures/searchIndexProof.ts`
  const corpusModule = `/@fs/${process.cwd()}/apps/fluux/src/demo/conversations/index.ts`
  const result = await page.evaluate(async ({ fixture, corpusModule, stage }) => {
    const { measureSearchHistory } = await import(fixture)
    const { getDemoMessages } = await import(corpusModule)
    const corpus = [...getDemoMessages().values()].flat().filter(message => message.body && !message.isRetracted)
    return measureSearchHistory(corpus, 50_000, stage)
  }, { fixture, corpusModule, stage })
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  await writeFile(output, JSON.stringify({ sourceHead, browser: browser.version(), ...result }, null, 2) + '\n')
  if (result.count !== 50_000 || (stage === 'candidate' && (result.state.status !== 'usable' || result.facetRows === 0 ||
      result.reads.some(read => read.outOfSpan !== 0 || read.postingRows === 0 || read.resultIds.length === 0)))) throw new Error('Search fixture or date-window invariant failed; inspect the recorded observations')
} finally { await browser.close() }
