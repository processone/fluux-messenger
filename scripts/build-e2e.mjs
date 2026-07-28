#!/usr/bin/env node
/**
 * Build the bundled demo the Playwright suites run against.
 *
 * Why a build at all. The suites used to run against the raw vite dev server, which
 * serves the app as ~3600 separate ES modules. WebKitGTK re-parses and re-executes that
 * graph in every fresh browser context — once per test — and on a 2-core CI runner the
 * first webkit test blew its 120s mount budget doing it, failing its first attempt in
 * ~15 of 16 observed green runs. A bundle turns that graph into a handful of chunks.
 *
 * Why not a production build. The harness drives the message list through seams that
 * `MessageList.tsx` installs only behind `import.meta.env.DEV`. A production build strips
 * them and the suites cannot work. So this builds with NODE_ENV=development, which is what
 * keeps `import.meta.env.DEV` true, and FLUUX_E2E_BUILD=1, which adds demo.html to the
 * rollup input and opts out of the strip-demo plugin.
 *
 * The seam check below is the point of this script. NODE_ENV is load-bearing but invisible:
 * drop it and the build still succeeds, still emits demo.html, and produces a bundle in
 * which two of the three seams are simply absent — the suites would then fail deep inside
 * unrelated assertions. Verified: without NODE_ENV=development this check goes from 3/3
 * to 1/3.
 *
 * Usage: npm run build:e2e   (from the repo root)
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'apps', 'fluux')
const DIST = join(APP, 'dist')

/**
 * Seams installed behind `import.meta.env.DEV` in MessageList.tsx, and used by
 * scripts/scroll-invariants.ts. These specifically discriminate a development build from
 * a production one — the other `__fluux*` globals are installed unconditionally and
 * survive a production build, so asserting those would prove nothing.
 */
const DEV_ONLY_SEAMS = ['__fluuxGetVirtOffset', '__fluuxTriggerLoadOlder', '__fluuxTriggerMediaLoad']

const build = spawnSync('npx', ['vite', 'build'], {
  cwd: APP,
  stdio: 'inherit',
  env: { ...process.env, FLUUX_E2E_BUILD: '1', NODE_ENV: 'development' },
})

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

const fail = (message) => {
  console.error(`\nbuild:e2e — ${message}`)
  process.exit(1)
}

if (!existsSync(join(DIST, 'demo.html'))) {
  fail('dist/demo.html is missing. The strip-demo plugin should opt out when FLUUX_E2E_BUILD=1.')
}

const assetsDir = join(DIST, 'assets')
if (!existsSync(assetsDir)) {
  fail('dist/assets is missing — the build produced no output.')
}

const bundle = readdirSync(assetsDir)
  .filter(name => name.endsWith('.js'))
  .map(name => readFileSync(join(assetsDir, name), 'utf8'))
  .join('\n')

const missing = DEV_ONLY_SEAMS.filter(seam => !bundle.includes(seam))
if (missing.length > 0) {
  fail(
    `the bundle is missing ${missing.length} of ${DEV_ONLY_SEAMS.length} dev-only harness seam(s): ${missing.join(', ')}.\n` +
      'This means import.meta.env.DEV resolved false — check that NODE_ENV=development reaches vite.\n' +
      'Without these the e2e suites fail deep inside unrelated assertions.',
  )
}

console.log(`build:e2e — demo.html emitted, ${DEV_ONLY_SEAMS.length}/${DEV_ONLY_SEAMS.length} dev seams present.`)
