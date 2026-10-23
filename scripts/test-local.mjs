#!/usr/bin/env node
// Local iteration policy: dependency selection plus explicit cross-language contracts.
// CI keeps its own full-family gates; this command never changes their scope.
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = 'apps/fluux'
const sdk = 'packages/fluux-sdk'
const native = `${app}/src-tauri`
const mainManifest = `${native}/Cargo.toml`
const nseManifest = `${native}/nse-openpgp/Cargo.toml`
const workspaces = { app: '@xmpp/fluux', sdk: '@fluux/sdk' }

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Git collection failed: ${result.error?.message ?? result.stderr.trim()}`)
  return result.stdout
}

export function parseDiff(text) {
  const fields = text.split('\0')
  const entries = []
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++]
    const path = fields[i++]
    if (!status || path === undefined) throw new Error('Incomplete Git change record')
    if (/^[RC]/.test(status)) {
      const destination = fields[i++]
      if (!destination) throw new Error('Incomplete Git rename record')
      entries.push({ path, status: 'R' }, { path: destination, status: 'R' })
    } else {
      entries.push({ path, status: status[0] })
    }
  }
  return entries
}

export function collectChanges({ cwd = root, base, paths = [] } = {}) {
  if (base && paths.length) throw new Error('Use either --base or explicit paths, not both')
  const entries = []
  if (paths.length) {
    for (const path of paths) {
      const absolute = resolve(cwd, path)
      const local = relative(cwd, absolute).split(sep).join('/')
      if (!local || local === '..' || local.startsWith('../')) throw new Error(`Path outside the project: ${path}`)
      entries.push({ path: local, status: existsSync(absolute) ? 'M' : 'D' })
    }
  } else {
    if (base) {
      const ancestor = git(cwd, ['merge-base', base, 'HEAD']).trim()
      entries.push(...parseDiff(git(cwd, ['diff', '--name-status', '-z', '--find-renames', ancestor, 'HEAD', '--'])))
    }
    // Separate index and working tree diffs preserve both sides even if one undoes the other.
    entries.push(...parseDiff(git(cwd, ['diff', '--cached', '--name-status', '-z', '--find-renames', 'HEAD', '--'])))
    entries.push(...parseDiff(git(cwd, ['diff', '--name-status', '-z', '--find-renames', '--'])))
    entries.push(...git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
      .map(path => ({ path, status: 'A' })))
  }
  const merged = new Map()
  for (const entry of entries) {
    const previous = merged.get(entry.path)
    if (!previous || !['D', 'R'].includes(previous.status)) merged.set(entry.path, entry)
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export function parseArgs(args) {
  const options = { paths: [], list: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { options.paths.push(...args.slice(i + 1)); break }
    if (args[i] === '--list') options.list = true
    else if (args[i] === '--help' || args[i] === '-h') options.help = true
    else if (args[i] === '--base') {
      if (options.base || !args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--base needs one Git reference')
      options.base = args[++i]
    } else if (args[i].startsWith('-')) throw new Error(`Unknown option: ${args[i]}`)
    else options.paths.push(args[i])
  }
  return options
}

export function createPlan(changes, cwd = root) {
  const steps = new Map()
  const notes = new Set()
  const full = new Set()
  const related = { app: new Set(), sdk: new Set() }
  const direct = { app: new Set(), sdk: new Set() }
  const add = (id, command, args, reason, extra = {}) => {
    if (!steps.has(id)) steps.set(id, { id, command, args, reasons: [], ...extra })
    const step = steps.get(id)
    if (!step.reasons.includes(reason)) step.reasons.push(reason)
  }
  const npm = (name, reason, extra = {}) => add(name, 'npm', ['run', name], reason, extra)
  const nodeTest = (path, reason, args = []) => add(`node:${path}:${args.join(' ')}`, 'node', ['--test', '--test-concurrency=1', ...args, path], reason)
  const fullJs = reason => {
    full.add('sdk'); full.add('app')
    npm('test:tauri-features', reason)
    npm('test:platform-policy', reason)
  }
  const gate = reason => {
    fullJs(reason)
    npm('typecheck', reason)
    npm('build', reason)
    notes.add('Unknown or cross-cutting scope: review native/browser qualification in docs/PLATFORM_REGRESSIONS.md; npm test does not cover every native suite.')
  }
  const cargo = (manifest, reason, pkg, production = false) => add(`cargo:${manifest}:${pkg ?? ''}:${production}`, 'cargo',
    ['test', '--locked', '--manifest-path', manifest, ...(pkg ? ['-p', pkg] : []), ...(production ? ['--features', 'production-tls'] : [])], reason)
  const platform = reason => {
    npm('test:platform', reason)
    notes.add('Platform contracts use mocks. Native changes still require the relevant unsigned build and isolated application/device scenario; this command never signs or installs an app.')
  }
  const iosGeneration = reason => {
    npm('test:ios-project', reason)
    npm('test:ios-generated-files', reason)
    npm('test:ios-extensions', reason, { requires: 'mac' })
  }
  const communication = reason => {
    nodeTest('scripts/macos-communication.test.mjs', reason)
    npm('check:tls-build', reason)
    add('cargo:communication-prototype', 'cargo', ['test', '--locked', '--manifest-path', mainManifest,
      '--features', 'macos-communication-prototype'], reason, { requires: 'mac' })
  }
  const nativeConfig = reason => {
    communication(reason)
    fullJs(reason); platform(reason)
    cargo(mainManifest, reason)
    cargo(mainManifest, reason, undefined, true)
    npm('test:tauri-features', reason)
    npm('check:tls-build', reason)
    iosGeneration(reason)
    notes.add('Native configuration changed: review macOS/Windows/Linux and mobile build requirements; host tests alone do not qualify other operating systems.')
  }
  const notification = reason => npm('test:ios-notifications', reason, { requires: 'mac' })
  const photos = reason => npm('test:ios-photos', reason, { requires: 'photos' })
  const share = reason => {
    npm('test:ios-extensions', reason, { requires: 'mac' })
    npm('test:ios-share', reason, { requires: 'share' })
    nodeTest('scripts/macos-share.test.mjs', reason)
  }
  const packageContract = reason => {
    npm('test:node --workspace=@fluux/sdk', reason)
    npm('test:package --workspace=@fluux/sdk', reason)
  }

  for (const { path, status } of changes) {
    const reason = `${status} ${path}`
    if (/macos\/CommunicationNotification\.[mh]$|scripts\/(macos-communication\.test\.mjs|native-tests\/MacCommunicationTests\.m)$/.test(path)) {
      communication(reason)
      platform(reason)
      continue
    }
    const removed = status === 'D' || status === 'R'
    // Only known documentation roots are exempt, never generated permission references.
    if (/^(docs\/.*\.(md|png|jpg|svg)|README\.md|CONTRIBUTING\.md|CHANGELOG\.md|RELEASE_NOTES\.md|LICENSE)$/.test(path)) {
      notes.add(`Documentation only: ${path}`)
      continue
    }
    if (removed) {
      if (path.startsWith(`${sdk}/`)) fullJs(`Deletion/rename: ${path}`)
      else if (path.startsWith(`${app}/src/`)) full.add('app')
      else gate(`Deletion/rename: ${path}`)
    }
    if (/^(package(-lock)?\.json|patches\/|\.github\/|tsconfig|\.cargo\/|scripts\/test-(local(?:-related)?(?:\.test)?\.mjs|affected\.sh))/.test(path)) {
      gate(reason)
      nodeTest('scripts/test-local-related.test.mjs', reason)
      if (/^(package|patches\/)/.test(path)) { packageContract(reason); nativeConfig(reason) }
      if (path.startsWith('.cargo/')) nativeConfig(reason)
      continue
    }
    if (path === 'tests/platform/matrix.json' || path.startsWith('tests/platform/')) {
      platform(reason); continue
    }
    if (path === 'tests/fixtures/notification-content.json') {
      notification(reason); fullJs(reason); continue
    }
    if (path.startsWith(`${app}/src/i18n/locales/`) && path.endsWith('.json')) {
      direct.app.add(`${app}/src/i18n/i18n.test.ts`)
      nodeTest('scripts/ios-notification-previews.test.mjs', reason, ['--test-name-pattern', '^native notification wording matches every i18n locale$'])
      continue
    }
    const workspace = path.startsWith(`${sdk}/src/`) || path.startsWith(`${sdk}/examples/`) ? 'sdk'
      : path.startsWith(`${app}/src/`) || path.startsWith(`${app}/scripts/`) ? 'app' : undefined
    if (workspace && /\.(ts|tsx)$/.test(path)) {
      if (workspace === 'sdk') {
        related.sdk.add(path); related.app.add(path)
        if (/(\/src\/(index|[^/]+\/index)\.ts$|\/src\/(core|stores|cache|crypto)\/|sasl|auth|connection|persist|openpgp|omemo)/i.test(path)) {
          fullJs(reason)
          platform(reason)
          packageContract(reason)
        }
      } else related.app.add(path)
      if (/\.test\.tsx?$/.test(path)) direct[workspace].add(path)
      if (/(\/platform\/|tauri|native|reconnectIntent)/i.test(path)) platform(reason)
      if (!removed && /test-setup|\/src\/(stores|services|crypto|anomaly)\/|\/src\/main\.tsx?$|encrypt|openpgp|omemo|persist|session|auth|login|keychain|secret|identity|connection/i.test(path)) {
        if (workspace === 'sdk') fullJs(reason)
        else full.add('app')
      }
      continue
    }
    if (path.startsWith(`${native}/nse-openpgp/`)) {
      cargo(nseManifest, reason)
      cargo(mainManifest, reason)
      notification(reason); platform(reason)
      if (/Cargo\.(toml|lock)$|build\.rs$|\/\.cargo\//.test(path)) nativeConfig(reason)
      continue
    }
    const plugin = path.match(new RegExp(`^${native}/plugins/([^/]+)/`))?.[1]
    if (path.startsWith(`${native}/`) && /\.rs$/.test(path)) {
      if (plugin) cargo(mainManifest, reason, `tauri-plugin-${plugin}`)
      if (plugin === 'push') notification(reason)
      // Consumers are deliberately retained: the selector cannot infer an IPC signature change.
      cargo(mainManifest, reason)
      if (['macos.rs', 'mod.rs', 'backend.rs'].some(name => path === `${native}/src/notifications/${name}`)) communication(reason)
      platform(reason)
      if (/build\.rs$/.test(path)) nativeConfig(reason)
      if (/tls|xmpp_proxy/.test(path)) { cargo(mainManifest, reason, undefined, true); npm('check:tls-build', reason) }
      if (/openpgp|crypto|keychain|identity|session|auth/i.test(path)) fullJs(reason)
      continue
    }
    if (path.startsWith(`${native}/`) && /Cargo\.(toml|lock)$|\/build\.rs$|\/\.cargo\/|\/permissions\/|\/capabilities\/|\/gen\/|\/tauri\.[^/]*json$/.test(path)) {
      if (plugin) cargo(mainManifest, reason, `tauri-plugin-${plugin}`)
      nativeConfig(reason)
      continue
    }
    if (/PhotoPreparation\.swift$|ShareInboxPlugin\.swift$|scripts\/ios-photo-reduction\.test\.mjs$|scripts\/native-tests\/PhotoPreparationTests\.swift$/.test(path)) {
      photos(reason); platform(reason); continue
    }
    if (/ShareViewController\.swift$|scripts\/native-tests\/(ios-share\/|SharedURLTests\.swift$)|scripts\/(macos-share|ios-extension-identifiers|ios-share-schemes)\.test\.mjs$/.test(path)) {
      share(reason); platform(reason); continue
    }
    if (path.startsWith('scripts/native-tests/ios-diagnostic/')) {
      npm('test:ios-diagnostic', reason, { requires: 'diagnostic' })
      notification(reason); platform(reason); continue
    }
    if (path.startsWith(`${native}/plugins/push/`) || /Notification(Service|PreviewEngine)\.swift$|scripts\/ios-(notifications|notification-previews|notification-diagnostic|quick-wins|app-intents)\.test\.mjs$|scripts\/native-tests\/(Notification|Preview|IOSQuickWins|IOSAppIntents|preview-identity|sdk-ts-loader)/.test(path)) {
      notification(reason); platform(reason); continue
    }
    if (/mobile-share-resources\.mjs$/.test(path)) {
      iosGeneration(reason); photos(reason); share(reason)
      notification(reason)
      nodeTest('scripts/android-prepare.test.mjs', reason)
      continue
    }
    if (/ios|IOS/.test(path) && (path.startsWith(`${native}/`) || path.startsWith(`${app}/scripts/`) || path.startsWith('scripts/'))) {
      iosGeneration(reason)
      gate(reason)
      notes.add(`Review additional native behavior tests (including privacy/device steps if applicable): ${path}`)
      if (/\.test\.mjs$/.test(path) && !/privacy-cover/.test(path)) nodeTest(path, reason)
      continue
    }
    if (/^(apps\/fluux|packages\/fluux-sdk)\/(package(-lock)?\.json|.*config.*|tsconfig.*)/.test(path)) {
      fullJs(reason)
      npm('typecheck', reason); npm('build', reason)
      if (path.endsWith('package.json')) { packageContract(reason); nativeConfig(reason) }
      continue
    }
    if (path.startsWith('e2e/')) {
      npm('test:e2e', reason)
      continue
    }
    if (path.startsWith('scripts/') && /\.test\.mjs$/.test(path)) nodeTest(path, reason)
    gate(reason)
    if (path.startsWith(`${native}/`) || path.startsWith('.cargo/')) nativeConfig(reason)
  }

  // SDK examples consume dist, including during graph discovery. Rebuild before selecting.
  const needsSdk = full.has('sdk') || related.sdk.size || steps.has('test:platform') || [...steps.keys()].some(key => key.startsWith('test:package') || key.startsWith('test:node'))
  const result = []
  if (steps.size || full.size || related.app.size || related.sdk.size || direct.app.size || direct.sdk.size) {
    result.push({ id: 'test:local:policy', command: 'npm', args: ['run', 'test:local:policy'], reasons: ['Validate the routing policy before selecting tests'] })
  }
  if (needsSdk) result.push({ id: 'build:sdk', command: 'npm', args: ['run', 'build:sdk'], reasons: ['SDK examples and package consumers require fresh dist'] })
  for (const name of ['sdk', 'app']) {
    const sources = [...related[name]].filter(path => !/\.test\.tsx?$/.test(path)).map(path => resolve(cwd, path))
    const directPaths = [...direct[name]].map(path => resolve(cwd, path))
    if (full.has(name)) result.push({ id: `full:${name}`, command: 'npm', args: ['run', 'test:run', '-w', workspaces[name]], reasons: ['Conservative full-family fallback', ...changes.filter(c => (name === 'app' ? c.path.startsWith(app) : c.path.startsWith(sdk))).map(c => `${c.status} ${c.path}`)] })
    else if (related[name].size || direct[name].size) result.push({ id: `related:${name}`, kind: 'related', workspace: name,
      sources, direct: directPaths, command: 'npm',
      args: sources.length ? ['exec', '-w', workspaces[name], '--', 'vitest', 'related', ...sources, '--run']
        : ['exec', '-w', workspaces[name], '--', 'vitest', 'run', ...directPaths],
      reasons: ['Related imports plus changed tests; empty production selection widens to the full workspace'] })
  }
  // Workspace scripts with arguments use separate argv entries, never a shell command.
  for (const step of steps.values()) {
    if (step.id.includes(' --workspace=')) step.args = ['run', ...step.id.split(' ')]
    result.push(step)
  }
  if (related.app.size || related.sdk.size || direct.app.size || direct.sdk.size) notes.add('Also run typecheck in each changed workspace (and API consumers), and the relevant build/browser/native checks; targeted tests do not replace them.')
  return { steps: result, notes: [...notes] }
}

function quote(text) { return /^[\w./:@=+-]+$/.test(text) ? text : JSON.stringify(text) }
export function printPlan(plan, write = console.log) {
  if (!plan.steps.length) write('No tests selected: no code changes, or only explicitly identified documentation.')
  for (const step of plan.steps) {
    write(`\n${[step.command, ...step.args].map(quote).join(' ')}`)
    for (const reason of step.reasons) write(`  Why: ${reason}`)
    if (step.kind === 'related') {
      write('  Discover tests first; include changed tests explicitly; explain and widen an empty production selection.')
      if (step.sources.length && step.direct.length) write(`  Also retain: ${['npm', 'exec', '-w', workspaces[step.workspace], '--', 'vitest', 'run', ...step.direct].map(quote).join(' ')}`)
    }
    if (step.requires) write(`  Required evidence: ${step.requires}; unavailable tools/fixtures fail rather than pass as a skip.`)
  }
  for (const note of plan.notes) write(`Note: ${note}`)
}

function run(command, args, cwd, capture = false) {
  // npm exposes its script entry point, avoiding a shell (and .cmd quoting on Windows).
  const executable = command === 'npm' && process.env.npm_execpath ? process.execPath : command
  const argv = executable !== command ? [process.env.npm_execpath, ...args] : args
  const result = spawnSync(executable, argv, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 32 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message ?? result.signal})${capture ? `\n${result.stderr}\n${result.stdout}` : ''}`)
  return result.stdout
}

export function checkRequirement(requirement, cwd, env = process.env, host = process.platform) {
  if (!requirement) return
  if (host !== 'darwin') throw new Error(`Missing native evidence: ${requirement} requires macOS/Xcode; do not count a skipped native test as passing`)
  if (requirement === 'photos' && (!env.FLUUX_PHOTO_FIXTURES || !existsSync(env.FLUUX_PHOTO_FIXTURES) || !statSync(env.FLUUX_PHOTO_FIXTURES).isDirectory())) {
    throw new Error('Missing photo evidence: set FLUUX_PHOTO_FIXTURES to real JPEG/HEIC fixtures; a skipped test is not validation')
  }
  if (requirement === 'share' || requirement === 'diagnostic') {
    const variable = requirement === 'share' ? 'FLUUX_SHARE_RESULTS' : 'FLUUX_DIAGNOSTIC_RESULTS'
    const destination = env[variable]
    if (!destination || !isAbsolute(destination)) throw new Error(`Set ${variable} to an absolute output directory outside the project`)
    // Resolve existing ancestors, so a symlink cannot redirect evidence into the project.
    let ancestor = resolve(destination)
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    const output = resolve(realpathSync(ancestor), relative(ancestor, resolve(destination)))
    const local = relative(realpathSync(cwd), output)
    if (!local || (!local.startsWith(`..${sep}`) && local !== '..' && !isAbsolute(local))) throw new Error(`${variable} must be outside the project`)
  }
}

export function executePlan(plan, { cwd = root, invoke = run, write = console.log, env = process.env, host = process.platform } = {}) {
  // Check known fixture gaps before any expensive work starts.
  for (const step of plan.steps) checkRequirement(step.requires, cwd, env, host)
  for (const step of plan.steps) {
    if (step.kind !== 'related') { invoke(step.command, step.args, cwd); continue }
    const ws = workspaces[step.workspace]
    let selected = []
    if (step.sources.length) {
      const text = invoke('node', [resolve(cwd, 'scripts/test-local-related.mjs'), resolve(cwd, step.workspace === 'app' ? app : sdk), ...step.sources], cwd, true)
      try { selected = JSON.parse(text) } catch { throw new Error(`Could not read Vitest selection for ${ws}: ${text}`) }
      if (!Array.isArray(selected) || selected.some(path => typeof path !== 'string')) throw new Error(`Invalid Vitest selection for ${ws}`)
      if (!selected.length) {
        write(`No related tests found for production sources in ${ws}; widening to the full workspace.`)
        invoke('npm', ['run', 'test:run', '-w', ws], cwd)
        continue
      }
      write(`Selected ${selected.length} related files in ${ws}:\n${selected.join('\n')}`)
      invoke('npm', ['exec', '-w', ws, '--', 'vitest', 'related', ...step.sources, '--run'], cwd)
    }
    const direct = step.direct.filter(path => !selected.includes(path))
    if (direct.length) invoke('npm', ['exec', '-w', ws, '--', 'vitest', 'run', ...direct], cwd)
  }
}

export function main(args = process.argv.slice(2), { cwd = root, invoke = run, write = console.log } = {}) {
  const options = parseArgs(args)
  if (options.help) {
    console.log('Usage: npm run test:local -- [--list] [--base <ref> | <path> ...]\nDefault: staged, unstaged and untracked paths. --base adds branch changes since the merge-base.\n--list prints commands and reasons without builds or test discovery. Run from the project root.')
    return
  }
  const changes = collectChanges({ ...options, cwd })
  write(`Local test plan: ${changes.length} changed path(s). Suites run sequentially; coordinate other heavy jobs before executing.`)
  const plan = createPlan(changes, cwd)
  printPlan(plan, write)
  if (!options.list) executePlan(plan, { cwd, invoke, write })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
