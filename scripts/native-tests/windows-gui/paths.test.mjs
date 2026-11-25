import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalDestination, contains, requireOutside } from './paths.mjs'

test('output boundaries compare path components, including children beginning with two dots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fluux-output-boundary-'))
  try {
    const checkout = join(root, 'checkout')
    const workspace = join(root, 'fluux-windows-gui-smoke')
    await mkdir(checkout); await mkdir(workspace)
    assert.equal(contains(checkout, join(checkout, '..cache')), true)
    assert.throws(() => requireOutside(checkout, join(checkout, '..cache'), 'Workspace'), /outside/)
    assert.throws(() => requireOutside(workspace, join(workspace, '..evidence'), 'Evidence'), /outside/)
    assert.doesNotThrow(() => requireOutside(checkout, workspace, 'Workspace'))
  } finally { await rm(root, { recursive: true }) }
})

test('canonical parents expose output aliases into a checkout or disposable workspace before creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fluux-output-alias-'))
  try {
    const checkout = join(root, 'checkout')
    const workspace = join(root, 'fluux-windows-gui-smoke')
    await mkdir(checkout); await mkdir(workspace)
    const checkoutAlias = join(root, 'checkout-alias')
    const workspaceAlias = join(root, 'workspace-alias')
    await symlink(checkout, checkoutAlias, 'junction')
    await symlink(workspace, workspaceAlias, 'junction')
    const canonicalCheckout = await canonicalDestination(checkout)
    const canonicalWorkspace = await canonicalDestination(workspace)
    assert.throws(() => requireOutside(canonicalCheckout, join(canonicalCheckout, 'new-output'), 'Evidence'), /outside/)
    assert.equal(await canonicalDestination(join(checkoutAlias, 'new-output')), join(canonicalCheckout, 'new-output'))
    assert.equal(await canonicalDestination(join(workspaceAlias, 'new-output')), join(canonicalWorkspace, 'new-output'))
    assert.throws(() => requireOutside(canonicalWorkspace, join(canonicalWorkspace, 'new-output'), 'Evidence'), /outside/)
    assert.notEqual(await canonicalDestination(workspaceAlias), workspaceAlias)
  } finally { await rm(root, { recursive: true }) }
})
