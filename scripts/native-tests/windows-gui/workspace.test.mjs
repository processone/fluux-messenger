import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireWorkspace, cleanWorkspace, confirmWorkspaceStopped, leaseFile, releaseWorkspace, requireWorkspaceJob, startWorkspaceJob } from './workspace.mjs'

test('clean refuses a held or unconfirmed workspace and deletes it only after confirmed shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fluux-workspace-guard-'))
  const workspace = join(root, 'fluux-windows-gui-smoke')
  await mkdir(workspace)
  await mkdir(join(workspace, 'webview-profile'))
  const profile = join(workspace, 'webview-profile', 'test-cache')
  await writeFile(profile, 'owned test profile')
  try {
    const lease = await acquireWorkspace(workspace)
    await assert.rejects(cleanWorkspace(workspace), { code: 'EEXIST' })
    await assert.rejects(requireWorkspaceJob(lease), /owned workspace launcher/)
    await startWorkspaceJob(lease)
    await requireWorkspaceJob(lease)
    await assert.rejects(releaseWorkspace(lease), /shutdown was not confirmed/)
    await assert.rejects(cleanWorkspace(workspace), { code: 'EEXIST' })
    assert.equal(await readFile(profile, 'utf8'), 'owned test profile')
    await confirmWorkspaceStopped(lease)
    await releaseWorkspace(lease)
    await cleanWorkspace(workspace)
    await assert.rejects(readFile(profile), { code: 'ENOENT' })
    await assert.rejects(readFile(leaseFile(workspace)), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true }) }
})

test('a different command cannot release another workspace owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fluux-workspace-owner-'))
  const workspace = join(root, 'fluux-windows-gui-smoke')
  try {
    const lease = await acquireWorkspace(workspace)
    const other = await acquireWorkspace(join(root, 'another-workspace'))
    await assert.rejects(releaseWorkspace({ ...lease, token: other.token }), /ownership changed/)
    assert.equal(JSON.parse(await readFile(lease.file, 'utf8')).token, lease.token)
    await releaseWorkspace(lease)
    await releaseWorkspace(other)
  } finally { await rm(root, { recursive: true }) }
})
