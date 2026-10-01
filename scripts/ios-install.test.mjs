import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fixture(t, { bundleId = 'net.processone.fluux.dev', buildFails = false, singleDevice = false } = {}) {
  const root = mkdtempSync(resolve(repo, '.ios-install-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const app = resolve(root, 'apps/fluux')
  // npm prepends workspace .bin paths; stubs must precede the real build tools.
  const bin = resolve(app, 'node_modules/.bin')
  const applications = resolve(app, 'src-tauri/gen/apple/build/fluux_iOS.xcarchive/Products/Applications')
  mkdirSync(resolve(app, 'scripts'), { recursive: true })
  mkdirSync(resolve(applications, 'Fluux Messenger iOS Dev.app'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  cpSync(resolve(repo, 'apps/fluux/scripts/tauri-ios-install.mjs'), resolve(app, 'scripts/tauri-ios-install.mjs'))
  const log = resolve(root, 'commands.log')
  const devices = resolve(root, 'devices.json')
  writeFileSync(devices, JSON.stringify({ result: { devices: [
    { identifier: 'iphone-udid', deviceProperties: { name: 'My iPhone' }, hardwareProperties: { platform: 'iOS' }, connectionProperties: { tunnelState: 'connected' } },
    { identifier: 'ipad-udid', deviceProperties: { name: 'My iPad' }, hardwareProperties: { platform: 'iOS' }, connectionProperties: { tunnelState: 'connected' } },
    { identifier: 'mac-udid', deviceProperties: { name: 'My Mac' }, hardwareProperties: { platform: 'macOS' } },
  ].filter((_, index) => !singleDevice || index === 0) } }))
  for (const command of ['npm', 'tauri', 'plutil', 'codesign', 'xcrun']) {
    const output = command === 'plutil' ? `printf '%s' '${bundleId}'`
      : command === 'tauri' && buildFails ? 'exit 1'
        : command === 'xcrun' ? 'if [ "$1" = devicectl ] && [ "$2" = list ]; then cat "$DEVICE_LIST"; fi' : ':'
    writeFileSync(resolve(bin, command), `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> "$COMMAND_LOG"\n${output}\n`, { mode: 0o755 })
  }
  const env = { ...process.env, APPLE_DEVELOPMENT_TEAM: 'TESTTEAM', PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, DEVICE_LIST: devices }
  const invoke = (args = [], input) => spawnSync(process.execPath, [resolve(app, 'scripts/tauri-ios-install.mjs'), ...args], { env, input, encoding: 'utf8' })
  const rootPackage = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8'))
  const appPackage = JSON.parse(readFileSync(resolve(repo, 'apps/fluux/package.json'), 'utf8'))
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({
    private: true, workspaces: ['apps/fluux'],
    scripts: { 'tauri:ios:install': rootPackage.scripts['tauri:ios:install'] },
  }))
  writeFileSync(resolve(root, 'apps/fluux/package.json'), JSON.stringify({
    name: appPackage.name,
    scripts: { 'tauri:ios:install': appPackage.scripts['tauri:ios:install'] },
  }))
  const npmCli = process.env.npm_execpath ?? realpathSync(resolve(dirname(process.execPath), 'npm'))
  writeFileSync(resolve(bin, 'npm'), `#!/bin/sh
if [ "$2" = tauri:ios:install ]; then
  exec "$NODE_BINARY" "$NPM_CLI" "$@"
fi
printf 'npm %s\\n' "$*" >> "$COMMAND_LOG"
`, { mode: 0o755 })
  const npmArgs = [npmCli, 'run', 'tauri:ios:install']
  const npmEnv = { ...env, NODE_BINARY: process.execPath, NPM_CLI: npmCli }
  const invokeNested = (args = [], input) => spawnSync(process.execPath, [...npmArgs, '--', ...args], {
    cwd: root, env: npmEnv, input, encoding: 'utf8', timeout: 10000,
  })
  const select = (answer, initialInput = '') => spawnSync('python3', ['-c', terminalDriver, process.execPath, ...npmArgs], {
    cwd: root, env: { ...npmEnv, MENU_ANSWER: answer, MENU_INITIAL_INPUT: initialInput }, encoding: 'utf8', timeout: 15000,
  })
  return { invoke, invokeNested, select, log, env }
}

test('builds and installs the signed device app on the requested device', t => {
  const { invoke, log } = fixture(t)
  const result = invoke(['iphone-udid'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const commands = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(commands[0], 'npm run build:sdk')
  assert.equal(commands[1], 'npm run tauri:ios:icons')
  assert.match(commands[2], /^tauri ios build --debug --target aarch64 --archive-only --ci$/)
  assert.match(commands[3], /^plutil -extract CFBundleIdentifier raw -o - /)
  assert.match(commands[4], /^codesign --verify --deep --strict /)
  assert.match(commands[5], /^xcrun devicectl device install app --device iphone-udid /)
})

test('rejects an unexpected app identity before installation', t => {
  const { invoke, log } = fixture(t, { bundleId: 'net.processone.fluux.demo' })
  const result = invoke(['iphone-udid'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unexpected bundle ID/)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /xcrun/)
})

test('stops when the device build fails', t => {
  const { invoke, log } = fixture(t, { buildFails: true })
  assert.notEqual(invoke(['iphone-udid']).status, 0)
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').length, 3)
})

test('shows a numbered iOS device menu and installs the selected device', t => {
  const { select, log } = fixture(t)
  const result = select('2\n')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /1\. My iPhone/)
  assert.match(result.stdout, /2\. My iPad/)
  assert.doesNotMatch(result.stdout, /My Mac/)
  assert.match(readFileSync(log, 'utf8'), /--device ipad-udid /)
})

test('stops after three invalid menu selections before building', t => {
  const { select, log } = fixture(t)
  const result = select('3\n3\n3\n')
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /Invalid device selection/)
  assert.match(result.stdout, /Too many invalid device selections/)
  assert.equal(result.stdout.match(/Select a device number/g)?.length, 3)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /npm|tauri/)
})

for (const answer of ['\n2\n', '3\n2\n']) {
  test(`retries ${answer.startsWith('\n') ? 'empty' : 'invalid'} input and installs the selected device`, t => {
    const { select, log } = fixture(t)
    const result = select(answer)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /Invalid device selection/)
    assert.equal(result.stdout.match(/Select a device number/g)?.length, 2)
    assert.match(readFileSync(log, 'utf8'), /--device ipad-udid /)
  })
}

test('can cancel after an invalid answer without building', t => {
  const { select, log } = fixture(t)
  const result = select('\n0\n')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /npm|tauri/)
})

test('recovers from Enter buffered before the menu appears', t => {
  const { select, log } = fixture(t)
  const result = select('2\n', '\n')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /Invalid device selection/)
  assert.equal(result.stdout.match(/Select a device number/g)?.length, 2)
  assert.match(readFileSync(log, 'utf8'), /--device ipad-udid /)
})

test('requires a signing team and rejects extra arguments before building', t => {
  const { invoke, log, env } = fixture(t)
  assert.notEqual(invoke(['iphone-udid', 'another-device']).status, 0)
  assert.notEqual(spawnSync(process.execPath, [resolve(repo, 'apps/fluux/scripts/tauri-ios-install.mjs'), 'iphone-udid'], {
    env: { ...env, APPLE_DEVELOPMENT_TEAM: '' }, encoding: 'utf8',
  }).status, 0)
  assert.throws(() => readFileSync(log))
})

test('nested npm invocation waits for cancellation before building', t => {
  const { select, log } = fixture(t)
  const result = select('0\n')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /npm|tauri/)
})

test('a single device still waits for a selection', t => {
  const { select, log } = fixture(t, { singleDevice: true })
  const result = select('0\n')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /1\. My iPhone/)
  assert.doesNotMatch(result.stdout, /My iPad/)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /npm|tauri/)
})

for (const input of [undefined, '1\n']) {
  test(`nested npm rejects non-interactive stdin (${input ? 'piped answer' : 'EOF'}) with device-id guidance`, t => {
    const { invokeNested, log } = fixture(t)
    const result = invokeNested([], input)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /npm run tauri:ios:install -- DEVICE_ID/)
    assert.doesNotMatch(result.stderr, /Invalid device selection/)
    assert.throws(() => readFileSync(log))
  })
}

test('nested npm forwards an explicit device id without interactive stdin', t => {
  const { invokeNested, log } = fixture(t)
  const result = invokeNested(['iphone-udid'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /Select a device/)
  assert.match(readFileSync(log, 'utf8'), /--device iphone-udid /)
})

test('terminal EOF reports device-id guidance rather than an invalid selection', t => {
  const { select, log } = fixture(t)
  const result = select('\x04')
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /npm run tauri:ios:install -- DEVICE_ID/)
  assert.doesNotMatch(result.stdout, /Invalid device selection/)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /npm|tauri/)
})

// Python's standard-library PTY lets nested npm inherit a terminal without hardware.
// Answers arrive after the prompt, so early EOF and prompts that never wait fail.
const terminalDriver = `
import errno, os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
os.write(fd, os.environ['MENU_INITIAL_INPUT'].encode())
output = b''
answer_at = None
sent = False
finished = False
try:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if answer_at and not sent and time.monotonic() >= answer_at:
            os.write(fd, os.environ['MENU_ANSWER'].encode())
            sent = True
        if not select.select([fd], [], [], 0.05)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b''
        if not chunk:
            finished = True
            break
        output += chunk
        if b'Select a device number' in output and answer_at is None:
            answer_at = time.monotonic() + 0.25
finally:
    if not finished:
        os.killpg(pid, signal.SIGKILL)
    os.close(fd)
    _, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
if not sent or not finished:
    sys.stderr.write('Prompt did not wait for input or command timed out')
    sys.exit(1)
sys.exit(os.waitstatus_to_exitcode(status))
`
