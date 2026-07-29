#!/usr/bin/env node
/**
 * CI gate: the anomaly instrumentation must be absent from a production build and
 * present in a Dev one.
 *
 * The build-audit vite plugin already asserts the module graph. This is the second,
 * independent check — a grep over the EMITTED assets for the runtime sentinel. Two
 * mechanisms because they fail differently: the plugin catches a module that
 * survived compilation, this catches the string reaching a chunk some other way,
 * and it runs against the artefact rather than inside the build.
 *
 * Direction is decided by FLUUX_ANOMALY, matching the flag the build itself read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SENTINEL = 'fluux-anomaly-instrumentation-present'
const DIST = 'apps/fluux/dist'

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

let files
try {
  files = walk(DIST)
} catch (err) {
  console.error(`FAIL: cannot read ${DIST} — run a build first. (${err.message})`)
  process.exit(1)
}

const carriers = files.filter(
  (file) => /\.(js|css|html)$/.test(file) && readFileSync(file, 'utf-8').includes(SENTINEL),
)

// Branch on the EXPECTED direction first. Checking "absent" unconditionally and
// exiting would abort a Dev run before it ever reached the presence check — the Dev
// build is supposed to contain the sentinel.
const expectPresent = process.env.FLUUX_ANOMALY === '1'

if (expectPresent) {
  if (carriers.length === 0) {
    console.error(
      'FAIL: the anomaly gate sentinel is ABSENT from a Dev build. The tree was ' +
        'eliminated where it was supposed to run — check that FLUUX_ANOMALY=1 reaches ' +
        'vite (see apps/fluux/src/anomaly/gate.ts).',
    )
    process.exit(1)
  }
  console.log(`OK: anomaly instrumentation present in the Dev bundle (${carriers.length} asset(s)).`)
} else {
  if (carriers.length > 0) {
    console.error(
      `FAIL: the anomaly gate sentinel survived into a production build:\n  ${carriers.join('\n  ')}`,
    )
    process.exit(1)
  }
  console.log('OK: no anomaly instrumentation in the production bundle.')
}
