/**
 * Intent: when macOS WebKit terminates a page after its GPU helper exits three times
 * (GPUProcessCrashedTooManyTimes), the e2e run fails at once with that reason instead of
 * hanging until the test limit. The watch lives in e2e/harness/webkitTermination.ts and starts
 * in bootDemo, which every suite boots through.
 *
 * The tests end the GPU helper three times within 30 s. WebKit counts these exits exactly as it
 * counts the helpers it kills for missing their deadline, and terminates the page itself. They
 * end only the helper of a browser they launched for themselves: once after the demo booted,
 * and once while the boot is still loading, which is when a helper misses its launch deadline.
 */
import { execFileSync } from 'node:child_process'
import { expect, test, type Browser, type PlaywrightWorkerArgs } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { GPU_TERMINATION_REASON, TERMINATION_ANNOTATION } from './harness/webkitTermination'

test.skip(process.platform !== 'darwin', 'only macOS WebKit has a GPU helper with a launch deadline, and a unified log to read')

/**
 * WebKit hands a browser's variables prefixed __XPC_ on to its helper processes with the prefix
 * removed, so this variable marks the helpers of the browser this test launches and no other.
 */
const OWNER_VARIABLE = 'FLUUX_E2E_GPU_HELPER_OWNER'

/** Far beyond the fast failure, and far below the test limit: reaching it means the watch missed. */
const PENDING_CALL_LIMIT_MS = 120_000
const FAST_FAILURE_MS = 15_000
const HELPER_START_LIMIT_MS = 20_000

function gpuHelpers(owner: string): number[] {
  const table = execFileSync('/bin/ps', ['-axEww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return table
    .split('\n')
    .filter(row => row.includes('com.apple.WebKit.GPU') && row.includes(`${OWNER_VARIABLE}=${owner}`))
    .map(row => Number(row.trim().split(/\s+/)[0]))
}

/** End the browser's running GPU helper, waiting for WebKit to start one if none runs yet. */
async function endGpuHelper(owner: string, ended: Set<number>): Promise<void> {
  const deadline = Date.now() + HELPER_START_LIMIT_MS
  for (;;) {
    const running = gpuHelpers(owner).filter(pid => !ended.has(pid))
    if (running.length > 0) {
      for (const pid of running) {
        process.kill(pid, 'SIGKILL')
        ended.add(pid)
      }
      return
    }
    if (Date.now() > deadline) throw new Error(`WebKit started no GPU helper within ${HELPER_START_LIMIT_MS} ms`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A WebKit browser of the test's own, whose helpers carry `owner` in their environment. */
async function launchOwnWebKit(playwright: PlaywrightWorkerArgs['playwright'], owner: string): Promise<Browser> {
  return playwright.webkit.launch({ env: { ...process.env, [`__XPC_${OWNER_VARIABLE}`]: owner } })
}

async function endGpuHelperThreeTimes(owner: string): Promise<number> {
  const ended = new Set<number>()
  for (let exit = 1; exit <= 3; exit++) await endGpuHelper(owner, ended)
  return Date.now()
}

function expectTerminationRecorded(): void {
  const annotation = test.info().annotations.find(entry => entry.type === TERMINATION_ANNOTATION)
  expect(annotation?.description, 'the test records the reason for later calls').toContain(GPU_TERMINATION_REASON)
}

test('a page WebKit terminates after three GPU helper exits fails at once with the reason', async ({ playwright, baseURL }) => {
  const owner = `${process.pid}-${Date.now()}`
  const browser = await launchOwnWebKit(playwright, owner)
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await bootDemo(page, new URL('/demo.html?tutorial=false', baseURL).href)

    // A call that only the termination can end, standing in for whatever a test awaits.
    const pendingCall = page
      .waitForFunction(() => false, undefined, { timeout: PENDING_CALL_LIMIT_MS })
      .then(() => null, (error: Error) => error)

    const thirdExitAt = await endGpuHelperThreeTimes(owner)
    const error = await pendingCall
    const waitedMs = Date.now() - thirdExitAt
    expect(error?.message, 'the pending call names WebKit\'s reason').toContain(GPU_TERMINATION_REASON)
    expect(waitedMs, 'the pending call failed soon after the third exit').toBeLessThan(FAST_FAILURE_MS)
    await expect(page.evaluate(() => 1), 'a later call fails at once').rejects.toThrow()
    expectTerminationRecorded()
  } finally {
    await browser.close()
  }
})

test('a page WebKit terminates while the demo boots fails the boot at once with the reason', async ({ playwright, baseURL }) => {
  const owner = `${process.pid}-${Date.now()}`
  const browser = await launchOwnWebKit(playwright, owner)
  try {
    const context = await browser.newContext()
    // Keeps drawing from the first moment of each document, as a loading page does, so WebKit
    // starts a new GPU helper after each exit.
    await context.addInitScript(() => {
      const canvas = document.createElement('canvas')
      let frame = 0
      setInterval(() => {
        if (!canvas.isConnected) document.documentElement?.appendChild(canvas)
        const drawing = canvas.getContext('2d')
        if (!drawing) return
        drawing.fillStyle = `hsl(${frame++ % 360} 50% 50%)`
        drawing.fillRect(0, 0, canvas.width, canvas.height)
      }, 16)
    })
    const page = await context.newPage()
    // Holds the demo's entry module, so the boot stays in its navigation until the termination.
    let releaseEntry: () => void = () => {}
    const entryHeld = new Promise<void>(resolve => {
      releaseEntry = resolve
    })
    await page.route('**/assets/demo-*.js', route => entryHeld.then(() => route.continue()).catch(() => {}))

    const boot = bootDemo(page, new URL('/demo.html?tutorial=false', baseURL).href).then(() => null, (error: Error) => error)
    const thirdExitAt = await endGpuHelperThreeTimes(owner)
    const error = await boot
    const waitedMs = Date.now() - thirdExitAt
    releaseEntry()
    expect(error?.message, 'the boot names WebKit\'s reason').toContain(GPU_TERMINATION_REASON)
    expect(waitedMs, 'the boot failed soon after the third exit').toBeLessThan(FAST_FAILURE_MS)
    expectTerminationRecorded()
  } finally {
    await browser.close()
  }
})
