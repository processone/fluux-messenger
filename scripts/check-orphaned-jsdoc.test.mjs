import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findOrphanedDocComments } from './check-orphaned-jsdoc.mjs'

test('flags a @param comment followed by another doc comment', () => {
  const source = [
    '  /**',
    '   * Set the subject.',
    '   * @param roomJid - The room',
    '   */',
    '  /**',
    '   * Something else entirely.',
    '   */',
    '  async somethingElse() {}',
  ].join('\n')

  const found = findOrphanedDocComments(source)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 1)
  assert.equal(found[0].summary, 'Set the subject.')
})

test('flags @returns as well, since it also documents a callable', () => {
  const source = ['/**', ' * Reads a thing.', ' * @returns the thing', ' */', '/** Next. */', 'const x = 1'].join('\n')
  assert.equal(findOrphanedDocComments(source).length, 1)
})

test('leaves a @param comment alone when a declaration follows it', () => {
  const source = ['  /**', '   * Set the subject.', '   * @param roomJid - The room', '   */', '  async setSubject() {}'].join('\n')
  assert.deepEqual(findOrphanedDocComments(source), [])
})

test('leaves adjacent comments alone when the first documents no callable', () => {
  // A module description followed by a constant's: the common legitimate shape.
  const source = [
    '/**',
    ' * Multi-User Chat module.',
    ' * @category Core',
    ' */',
    '/** Default timeout. */',
    'const JOIN_TIMEOUT_MS = 30000',
  ].join('\n')
  assert.deepEqual(findOrphanedDocComments(source), [])
})

test('leaves a blank line between comments alone', () => {
  // Separated blocks read as two independent comments, not a stranding.
  const source = ['/**', ' * Does a thing.', ' * @param a - first', ' */', '', '/** Next. */', 'const x = 1'].join('\n')
  assert.deepEqual(findOrphanedDocComments(source), [])
})

test('reports every stranded comment in a file', () => {
  const one = ['/**', ' * A.', ' * @param a - x', ' */', '/** B. */', 'const b = 1'].join('\n')
  const two = ['/**', ' * C.', ' * @param c - x', ' */', '/** D. */', 'const d = 1'].join('\n')
  assert.equal(findOrphanedDocComments(`${one}\n${two}`).length, 2)
})

test('ignores line comments that merely mention @param', () => {
  const source = ['// @param is not a doc tag here', 'const x = 1'].join('\n')
  assert.deepEqual(findOrphanedDocComments(source), [])
})
