/**
 * Fail fast when macOS WebKit terminates a page because its GPU helper exited too often.
 *
 * WebKit renders through a separate GPU helper process. It gives that helper 3 s to answer
 * once it has launched, and again each time a new page asks it for a connection; a helper
 * that misses the deadline is killed as unresponsive. When the helper exits three times within
 * 30 s, killed as unresponsive or crashed, WebKit terminates every web page of the browser with
 * the reason GPUProcessCrashedTooManyTimes and does not reload them.
 *
 * Playwright reports a terminated page as crashed only when WebKit's reason is a crash. After
 * this termination the page emits nothing: evaluate never settles, waits run to their limit
 * and navigation fails with "Cannot find web frame". A test sits until its 180 s budget and
 * reports a timeout that names nothing.
 *
 * The browser does log the termination, to the macOS unified log. While a worker has WebKit
 * pages, this module reads those log lines and, when this worker's own browser terminates its
 * pages, closes them with the reason. Playwright then rejects the pending call with that
 * reason as its message. A later call fails at once with Playwright's plain "has been closed",
 * so the reason is also written to the test's output and added to its annotations.
 *
 * A page from browser.newPage() owns its context, and Playwright closes such a page through
 * its context without passing the reason on to the pending call; the suites' pages come from
 * the test's own context.
 *
 * Linux, where CI runs, has no unified log to read, so there the watch is not started. See
 * "WebKit GPU helper terminations" in docs/DEVELOPER.md for what was measured about why the
 * helper misses its deadline.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { test, type Page } from '@playwright/test'

/** The reason WebKit gives the terminated pages, as it writes it to the log. */
export const GPU_TERMINATION_REASON = 'GPUProcessCrashedTooManyTimes'

/** The annotation type a test carries once its page was terminated this way. */
export const TERMINATION_ANNOTATION = 'webkit-page-terminated'

/**
 * Lines the browser's UI process writes: each GPU helper exit with its reason, and the
 * termination itself. Rare enough that every worker can read the same stream and keep only
 * its own browsers' lines.
 */
const LOG_PREDICATE = [
  'process == "Playwright"',
  'subsystem == "com.apple.WebKit"',
  `(eventMessage CONTAINS "GPUProcessProxy::gpuProcessExited" OR eventMessage CONTAINS "${GPU_TERMINATION_REASON}")`,
].join(' AND ')

/**
 * Run the log reader under a shell that waits for its standard input to close, then stops it.
 * The worker holds the other end of that pipe, so the reader ends with the worker, even when
 * the worker is killed and runs no cleanup of its own.
 */
const READER_SCRIPT = '/usr/bin/log stream --style ndjson --predicate "$1" & reader=$!; read -r _; kill "$reader" 2>/dev/null'

const GPU_EXIT = /GPUProcessProxy::gpuProcessExited: reason=(\w+)/

/** How many helper exits to quote per browser; WebKit acts on three. */
const EXITS_KEPT = 6

interface LogEntry {
  processID?: number
  timestamp?: string
  eventMessage?: string
}

const watchedPages = new Set<Page>()
const terminations = new WeakMap<Page, string>()
const helperExits = new Map<number, string[]>()
let reader: ChildProcess | null = null
let partialLine = ''

/**
 * Close `page` with WebKit's reason if this worker's WebKit browser terminates it after its
 * GPU helper exited too often. No-op outside macOS WebKit; safe to call more than once.
 */
export function watchForWebKitTermination(page: Page): void {
  if (process.platform !== 'darwin') return
  if (page.context().browser()?.browserType().name() !== 'webkit') return
  if (watchedPages.has(page) || page.isClosed()) return
  startReader()
  watchedPages.add(page)
  page.once('close', () => watchedPages.delete(page))
}

/** The message `page` was closed with, if this module closed it. */
export function webkitTerminationOf(page: Page): string | undefined {
  return terminations.get(page)
}

function startReader(): void {
  if (reader) return
  const child = spawn('/bin/sh', ['-c', READER_SCRIPT, 'webkit-termination-reader', LOG_PREDICATE], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  reader = child
  // A failed start leaves the suites as they were: they still run, without the fast failure.
  child.on('error', () => {
    if (reader === child) reader = null
  })
  child.on('exit', () => {
    if (reader === child) reader = null
  })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    partialLine += chunk
    const lines = partialLine.split('\n')
    partialLine = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  })
  // The reader must not hold the worker open: the pipe closing at exit is what stops it.
  child.unref()
  for (const stream of [child.stdin, child.stdout]) {
    ;(stream as unknown as { unref?: () => void } | null)?.unref?.()
  }
}

function handleLine(line: string): void {
  let entry: LogEntry
  try {
    entry = JSON.parse(line) as LogEntry
  } catch {
    return
  }
  const pid = entry.processID
  const message = entry.eventMessage ?? ''
  if (typeof pid !== 'number' || !isOwnDescendant(pid)) return

  const exit = GPU_EXIT.exec(message)
  if (exit) {
    const exits = helperExits.get(pid) ?? []
    exits.push(`${clockTime(entry.timestamp)} ${exit[1]}`)
    helperExits.set(pid, exits.slice(-EXITS_KEPT))
    return
  }
  if (message.includes(GPU_TERMINATION_REASON)) terminateWatchedPages(pid)
}

/**
 * A worker normally drives one WebKit browser, and the termination stops every page that
 * browser has, so every page watched in this worker is closed. A test that launches a second
 * WebKit browser of its own would see its pages closed too, which only makes it fail sooner.
 */
function terminateWatchedPages(browserPid: number): void {
  if (watchedPages.size === 0) return
  const reason = describeTermination(browserPid)
  for (const page of [...watchedPages]) {
    watchedPages.delete(page)
    terminations.set(page, reason)
    page.close({ reason }).catch(() => {})
  }
  console.error(reason)
  try {
    test.info().annotations.push({ type: TERMINATION_ANNOTATION, description: reason })
  } catch {
    // Between tests: the closed page has no test left to annotate.
  }
}

function describeTermination(browserPid: number): string {
  const exits = helperExits.get(browserPid) ?? []
  return [
    `WebKit terminated this page (${GPU_TERMINATION_REASON}): its GPU helper process exited ` +
      'three times within 30 s, so WebKit stopped every page of the browser and does not reload ' +
      'them. Playwright reports no crash for this; without this message the test would wait for ' +
      'its time limit.',
    exits.length > 0
      ? `GPU helper exits this browser logged: ${exits.join(', ')}.`
      : 'The GPU helper exits happened before this worker started reading the log.',
    'An exit marked Unresponsive is WebKit killing a helper that missed its 3 s deadline to ' +
      'answer; see "WebKit GPU helper terminations" in docs/DEVELOPER.md.',
  ].join('\n')
}

/** Whether `pid` was started, directly or through other processes, by this worker. */
function isOwnDescendant(pid: number): boolean {
  let table: string
  try {
    table = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  } catch {
    return false
  }
  const parents = new Map<number, number>()
  for (const row of table.split('\n')) {
    const [child, parent] = row.trim().split(/\s+/).map(Number)
    if (child) parents.set(child, parent)
  }
  for (let current = pid, hops = 0; current > 1 && hops < 64; hops++) {
    if (current === process.pid) return true
    current = parents.get(current) ?? 0
  }
  return false
}

/** "14:09:28.761" from the log's "2026-11-18 14:09:28.761234+0100". */
function clockTime(timestamp: string | undefined): string {
  return /\d{2}:\d{2}:\d{2}\.\d{3}/.exec(timestamp ?? '')?.[0] ?? 'unknown time'
}
