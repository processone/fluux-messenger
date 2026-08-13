import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractExamples } from './check-jsdoc-examples.mjs'

const doc = (body) => `/**\n${body}\n */\nexport const x = 1\n`

test('extracts a fenced typescript block from a doc comment', () => {
  const blocks = extractExamples(doc(' * ```typescript\n * const a = 1\n * ```'))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].language, 'typescript')
  assert.equal(blocks[0].code, 'const a = 1')
  assert.equal(blocks[0].fragment, false)
})

test('reports the line of the opening fence, so a failure points at the source', () => {
  const source = `const before = 1\n\n${doc(' * ```ts\n * const a = 1\n * ```')}`
  const blocks = extractExamples(source)
  assert.equal(blocks.length, 1)
  // Line 3 is `/**`, line 4 is the fence.
  assert.equal(blocks[0].line, 4)
})

test('ignores fences in languages that are not TypeScript', () => {
  const blocks = extractExamples(doc(' * ```bash\n * npm install\n * ```\n * ```xml\n * <iq/>\n * ```'))
  assert.deepEqual(blocks, [])
})

test('marks a block as a fragment when the fence says so', () => {
  const blocks = extractExamples(doc(' * ```tsx fragment\n * <App />\n * ```'))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].fragment, true)
})

test('an unknown modifier does not silently exempt a block', () => {
  const blocks = extractExamples(doc(' * ```tsx skipme\n * <App />\n * ```'))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].fragment, false)
})

test('keeps blank lines inside a block, so reported line numbers stay true', () => {
  const blocks = extractExamples(doc(' * ```ts\n * const a = 1\n *\n * const b = 2\n * ```'))
  assert.equal(blocks[0].code, 'const a = 1\n\nconst b = 2')
})

test('reads every block in a comment that carries several', () => {
  const blocks = extractExamples(
    doc(' * ```ts\n * const a = 1\n * ```\n * @example\n * ```ts\n * const b = 2\n * ```'),
  )
  assert.deepEqual(
    blocks.map((b) => b.code),
    ['const a = 1', 'const b = 2'],
  )
})

test('leaves ordinary comments alone', () => {
  const blocks = extractExamples('// ```ts\n// const a = 1\n// ```\nexport const x = 1\n')
  assert.deepEqual(blocks, [])
})
