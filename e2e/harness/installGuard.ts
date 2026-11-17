/**
 * Stop a browser gate before it builds or runs against an install that does not match
 * package-lock.json.
 *
 * Every Playwright config under e2e/ calls this as it loads, so the check runs before the
 * webServer builds the demo, before an already running server is reused, and before any
 * browser starts. The comparison itself is scripts/check-install-lock.mjs, which
 * `npm run build:e2e` also runs on its own; running that one script keeps the message the
 * same wherever a gate starts.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHECK = fileURLToPath(new URL('../../scripts/check-install-lock.mjs', import.meta.url))

export function requireLockedInstall(): void {
  // Playwright loads the config again in every worker process. The runner process already
  // checked before starting them, and the install cannot change in between.
  if (process.env.TEST_WORKER_INDEX !== undefined) return

  const result = spawnSync(process.execPath, [CHECK], { stdio: 'inherit' })
  if (result.error) {
    console.error(`[check-install-lock] could not run ${CHECK}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
