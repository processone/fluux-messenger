import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { open, readFile, rm, writeFile } from 'node:fs/promises'

// A sibling survives recursive workspace removal, so another command cannot enter halfway through clean.
export const leaseFile = workspace => `${workspace}.gui-workspace-lease.json`

export async function acquireWorkspace(workspace) {
  const lease = { file: leaseFile(workspace), token: randomUUID() }
  await writeFile(lease.file, JSON.stringify({ token: lease.token, state: 'idle' }), { flag: 'wx' })
  return lease
}

async function readLease(lease) {
  const state = JSON.parse(await readFile(lease.file, 'utf8'))
  assert.equal(state.token, lease.token, 'Workspace lease ownership changed')
  return state
}

async function writeLease(lease, state) {
  const file = await open(lease.file, 'r+')
  try { await file.truncate(0); await file.writeFile(JSON.stringify(state)) } finally { await file.close() }
}

export async function requireWorkspaceJob(lease) {
  assert.equal((await readLease(lease)).state, 'started', 'Start workers through the owned workspace launcher')
}

export async function startWorkspaceJob(lease) {
  const state = await readLease(lease)
  assert.equal(state.state, 'idle', 'Workspace already has an active or unconfirmed job')
  await writeLease(lease, { ...state, state: 'started' })
}

export async function confirmWorkspaceStopped(lease) {
  const state = await readLease(lease)
  assert.equal(state.state, 'started')
  await writeLease(lease, { ...state, state: 'stopped' })
}

export async function releaseWorkspace(lease) {
  const state = await readLease(lease)
  assert.ok(['idle', 'stopped'].includes(state.state), 'Retaining workspace lease: owned-job shutdown was not confirmed')
  await rm(lease.file)
}

export async function cleanWorkspace(workspace) {
  const lease = await acquireWorkspace(workspace)
  try { await rm(workspace, { recursive: true }) } finally { await releaseWorkspace(lease) }
}
