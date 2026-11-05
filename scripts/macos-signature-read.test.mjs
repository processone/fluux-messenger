import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { communicationIdentity } from '../apps/fluux/scripts/macos-communication-profile.mjs'
import { shareSettings } from '../apps/fluux/scripts/tauri-macos-share.mjs'
import { designatedRequirement, readSignature } from './verify-macos-release.mjs'

// FLM-439 F1/F2: a real public signature, not a test-authored codesign response.
// Explicit probe: missing fixture is missing evidence, never a successful skip on Darwin.
test('public 0.18.1 signature display writes XML, requirements and the requested DER certificate', { skip: process.platform !== 'darwin' }, () => {
  const app = process.env.FLUUX_MACOS_REFERENCE_APP
  assert.ok(app, 'Set FLUUX_MACOS_REFERENCE_APP to the extracted public 0.18.1 app; this probe never launches or installs it')
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-public-signature-'))
  try {
    const signature = readSignature(app, scratch, (command, args) => {
      assert.equal(command, '/usr/bin/codesign')
      assert.equal(args[0], '--display', 'this probe must never sign or look up a private identity')
      const result = spawnSync(command, args, { encoding: null, cwd: scratch })
      console.log(JSON.stringify({ command, args, status: result.status, stdoutBytes: result.stdout?.length }))
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stderr?.toString())
      return { stdout: result.stdout, stderr: result.stderr }
    })
    const config = JSON.parse(readFileSync('apps/fluux/src-tauri/tauri.conf.json'))
    const group = shareSettings(config, { APPLE_TEAM_ID: communicationIdentity.team }).group
    assert.ok(signature.entitlements['com.apple.security.application-groups'].includes(group))
    assert.equal(signature.requirement, designatedRequirement)
    const certificate = new X509Certificate(signature.certificate)
    assert.ok(certificate.subject.includes(`OU=${communicationIdentity.team}`))
    console.log(JSON.stringify({ publicReference: '0.18.1 macOS arm64', group, requirement: signature.requirement, certificateSubject: certificate.subject, certificateBytes: signature.certificate.length }))
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
