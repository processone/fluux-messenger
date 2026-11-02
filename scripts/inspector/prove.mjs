// FLM-349/351: disposable-only proof. Never discovers or connects to a phone.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'

const source = readFileSync(new URL('./sampler.js', import.meta.url), 'utf8')
const browser = await webkit.launch({ headless: true })
const samples = []
let version
try {
  version = browser.version()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.setContent(`<style>body{margin:0}#root{height:844px}[data-message-list]{height:120px;overflow:auto}[data-message-id]{height:40px}</style><div id="root"><div data-message-list>${Array.from({ length: 12 }, (_, i) => `<div data-index="${i}" data-message-id="disposable-${i}">Disposable row ${i}</div>`).join('')}</div></div>`)
  await page.evaluate(source)
  const sample = () => page.evaluate(() => window.__flm350_measurements.sample())
  samples.push(await sample())
  assert.equal(samples[0].mountedRows, 12)
  assert.equal(samples[0].intersectingRows, 3)
  assert.equal(await sample(), null)
  await page.waitForFunction(t => performance.now() - t >= 250, samples.at(-1).elapsedMs)
  await page.evaluate(() => { document.querySelector('[data-message-list]').style.display = 'none' })
  samples.push(await sample())
  assert.equal(samples.at(-1).intersectingRows, 0)
  assert.equal(samples.at(-1).list.display, 'none')
  await page.waitForFunction(t => performance.now() - t >= 250, samples.at(-1).elapsedMs)
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE-CANARY', error: new Error('PRIVATE-CANARY') }))
    document.querySelector('[data-message-list]').remove()
  })
  samples.push(await sample())
  assert.equal(samples.at(-1).list, null)
  assert.deepEqual(samples.at(-1).errors, ['window-error'])
  assert(!JSON.stringify(samples).includes('PRIVATE-CANARY'))
  assert(!JSON.stringify(samples).includes('disposable-'))
  assert.equal(await page.evaluate(() => window.__flm350_measurements.stop()), true)
  assert.equal(await page.evaluate(() => Object.hasOwn(window, '__flm350_measurements')), false)
  await page.evaluate(source)
  assert.equal(await page.evaluate(() => window.__flm350_measurements.stop()), true)
} finally {
  await browser.close()
}
const run = spawnSync('python3', ['-B', fileURLToPath(new URL('./test_reader.py', import.meta.url))], {
  input: JSON.stringify(samples), encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
})
process.stderr.write(run.stderr || '')
assert.equal(run.error, undefined)
const transport = JSON.parse(run.stdout)
console.log(JSON.stringify({ boundary: 'disposable WebKit + actual host reader on local sockets; not an iPhone',
  webkit: version, browserClosed: true, samples, samplerRemovedAndReattached: true, transport }, null, 2))
// Keep completed failed-case observations as well as their nonzero exit status.
assert.equal(run.status, 0)
