/**
 * Shared demo boot for the Playwright suites.
 *
 * Both the scroll and the composer harness need the same three things before they can
 * measure anything: the demo loaded, React mounted, and the stress seeding finished.
 * Keeping that here gives the readiness contract with demo.tsx a single owner.
 *
 * The boot is instrumented because it has an open, intermittent failure: the first webkit
 * test times out waiting for the app shell in a large fraction of CI runs, and `retries: 2`
 * relabels it "flaky". Measured, a healthy boot on the same runner takes ~1s (chromium) to
 * ~3.5s (webkit) — a ~30x gap to the 120s ceiling, so the failure is something stalling
 * rather than everything being slow. A single `waitForSelector` could only ever report
 * "the nav never came"; the staged waits below report WHERE it stopped.
 */
import type { ConsoleMessage, Page } from '@playwright/test'

/**
 * Total budget for getting from `goto` to a mounted app shell — unchanged from the single
 * wait it replaces. The stages share it rather than each getting their own, so a stage that
 * hangs consumes the remainder and is named in the error, which is the point.
 */
const MOUNT_BUDGET_MS = 120_000

/** Seeding is fast once the app is up — this ceiling only catches a genuine hang. */
const SEED_TIMEOUT_MS = 30_000

/**
 * How long the post-mortem probe waits for the page to answer. Short on purpose: if the
 * page cannot evaluate a trivial expression in this window, the main thread is blocked, and
 * saying so is worth more than any DOM detail we failed to collect.
 */
const LIVENESS_PROBE_MS = 5_000

/** Ordered milestones between "navigation started" and "the app is usable". */
const MOUNT_STAGES = [
  {
    name: 'document parsed',
    detail: 'the HTML response never finished parsing — a server or network stall',
    probe: () => document.readyState !== 'loading',
  },
  {
    name: 'mount node present',
    detail: 'index/demo HTML loaded but #root is absent — wrong document served',
    probe: () => document.getElementById('root') !== null,
  },
  {
    name: 'React rendered into #root',
    detail: 'the bundle loaded but never produced a first paint — a module-eval throw, or a render loop',
    probe: () => (document.getElementById('root')?.childElementCount ?? 0) > 0,
  },
  {
    name: 'app shell visible',
    detail: 'React rendered something, but the nav never appeared — an app-level stall, not a boot one',
    probe: () => document.querySelector('[data-nav="messages"]') !== null,
  },
] as const

interface BootDiagnostics {
  consoleErrors: string[]
  pageErrors: string[]
}

/**
 * Collect console errors and uncaught exceptions for the life of the page. A render loop
 * announces itself here (renderLoopDetector warns, and React's "Maximum update depth"
 * follows), which is exactly the class of failure a DOM snapshot alone would not explain.
 */
function attachDiagnostics(page: Page): BootDiagnostics {
  const diagnostics: BootDiagnostics = { consoleErrors: [], pageErrors: [] }
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.consoleErrors.push(`[${message.type()}] ${message.text()}`)
    }
  })
  page.on('pageerror', error => {
    diagnostics.pageErrors.push(error.message)
  })
  return diagnostics
}

/**
 * Ask the page a trivial question, and treat "no answer" as the answer.
 *
 * page.evaluate takes no timeout option, so the bound has to be a race — and it must be a
 * race rather than a try/catch, because a blocked main thread does not reject, it simply
 * never settles. That non-answer is the most informative outcome this probe has.
 */
async function probeLiveness(page: Page): Promise<string> {
  const query = page
    .evaluate(() => ({
      readyState: document.readyState,
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
      bodyChars: document.body?.innerText?.length ?? 0,
      url: location.href,
    }))
    .catch(() => null)

  const expiry = new Promise<null>(resolve => setTimeout(() => resolve(null), LIVENESS_PROBE_MS))
  const state = await Promise.race([query, expiry])

  if (!state) {
    return (
      `page UNRESPONSIVE — a trivial evaluate did not return within ${LIVENESS_PROBE_MS}ms. ` +
      'The main thread is blocked (render loop or a synchronous stall), not merely slow.'
    )
  }
  return `page responsive — readyState=${state.readyState}, #root children=${state.rootChildren}, visible text=${state.bodyChars} chars, url=${state.url}`
}

async function describeStall(
  page: Page,
  stage: (typeof MOUNT_STAGES)[number],
  diagnostics: BootDiagnostics,
  elapsedMs: number,
): Promise<string> {
  const liveness = await probeLiveness(page)
  const tail = (label: string, lines: string[]) =>
    lines.length === 0 ? `${label}: none` : `${label} (last 10):\n  ${lines.slice(-10).join('\n  ')}`

  return [
    `Demo boot stalled at stage "${stage.name}" after ${Math.round(elapsedMs / 1000)}s.`,
    `Likely meaning: ${stage.detail}.`,
    liveness,
    tail('console errors/warnings', diagnostics.consoleErrors),
    tail('uncaught page errors', diagnostics.pageErrors),
  ].join('\n')
}

/** Navigate to a demo URL and return once it is mounted and fully seeded. */
export async function bootDemo(page: Page, url: string): Promise<void> {
  const diagnostics = attachDiagnostics(page)
  const deadline = Date.now() + MOUNT_BUDGET_MS
  const remaining = () => Math.max(1, deadline - Date.now())

  // Explicit, so the ceiling does not depend on where the Page came from: inside a test
  // page.goto carries no limit of its own and is bounded by the test budget, while a Page
  // from a raw browser.launch() gets Playwright's 30s default.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() })

  for (const stage of MOUNT_STAGES) {
    try {
      await page.waitForFunction(stage.probe, undefined, { timeout: remaining(), polling: 250 })
    } catch {
      throw new Error(await describeStall(page, stage, diagnostics, MOUNT_BUDGET_MS - remaining()))
    }
  }

  await waitForDemoSeeded(page)
}

/**
 * Wait for the demo's stress seeding to actually complete.
 *
 * demo.tsx sets `__fluuxDemoReady` once runStressScenario's last scheduled event has been
 * emitted. This replaced a fixed 1.2s sleep that was both wasteful on a fast boot and a
 * silent race on a slow one — the seeding duration is a function of messagesPerRoom and
 * msgStepMs, so no constant can be right for every scenario.
 */
export async function waitForDemoSeeded(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as Window & { __fluuxDemoReady?: boolean }).__fluuxDemoReady === true,
    undefined,
    { timeout: SEED_TIMEOUT_MS },
  )
}
