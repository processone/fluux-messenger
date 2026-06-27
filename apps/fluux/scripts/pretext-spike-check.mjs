import { chromium } from 'playwright'

const URL = process.env.SPIKE_URL ?? 'http://localhost:5173/pretext-spike.html'

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'networkidle' })

// wait until the report stops saying "measuring..." (multiple scale passes can
// take a few seconds, so allow a generous timeout)
await page.waitForFunction(() => {
  const el = document.getElementById('report')
  return el && el.textContent && !el.textContent.startsWith('measuring')
}, { timeout: 30000 })

const raw = await page.$eval('#report', (el) => el.textContent ?? '')
await browser.close()

const out = JSON.parse(raw)
console.log('engine:', out.engine)
console.log('widths:', out.widths, 'scales:', out.scales)

let anyFail = false
for (const run of out.runs) {
  console.log(`\n--- character scale ${run.fontScalePct}% ---`)
  console.table(run.report.byCategory)
  console.log('text line-exact %:', run.report.overall.textLineExactPct.toFixed(2))
  if (!run.report.overall.passesThreshold) anyFail = true
}

const worst = out.runs.flatMap((r) =>
  r.report.worstOffenders.map((s) => `${r.fontScalePct}% ${s.id}@${s.widthPx} pred=${s.predicted.heightPx} meas=${s.measuredHeightPx}`),
)
console.log('\nworst offenders (across scales):', worst.slice(0, 15))

const totalSamples = out.runs.reduce((n, r) => n + Object.values(r.report.byCategory).reduce((m, c) => m + c.count, 0), 0)
if (out.runs.length === 0 || totalSamples === 0) {
  console.error('FAIL: no runs / no samples measured (page did not produce data)')
  process.exit(1)
}

if (anyFail) {
  console.error('FAIL: pretext below accuracy threshold on Chromium at one or more character scales')
  process.exit(1)
}
console.log('PASS: pretext meets accuracy threshold on Chromium across all character scales')
