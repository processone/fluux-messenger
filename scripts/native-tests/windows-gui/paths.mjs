import assert from 'node:assert/strict'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function contains(root, path) {
  // WSL's path library is case-sensitive, unlike the Windows drive holding the disposable workspace.
  const windowsDrive = value => /^\/mnt\/c(?:\/|$)/.test(value)
  const fold = windowsDrive(root) && windowsDrive(path)
  const local = relative(fold ? root.toLowerCase() : root, fold ? path.toLowerCase() : path)
  return local === '' || (!isAbsolute(local) && local.split(sep)[0] !== '..')
}

export async function canonicalDestination(path) {
  assert.ok(isAbsolute(path), 'Use an absolute path')
  let ancestor = resolve(path)
  const suffix = []
  while (true) {
    try { await lstat(ancestor); break } catch (error) {
      if (error.code !== 'ENOENT') throw error
      suffix.unshift(basename(ancestor))
      const parent = dirname(ancestor)
      assert.notEqual(parent, ancestor)
      ancestor = parent
    }
  }
  return resolve(await realpath(ancestor), ...suffix)
}

export function requireOutside(root, path, label) {
  assert.ok(!contains(root, path), `${label} must be outside ${root}`)
}
