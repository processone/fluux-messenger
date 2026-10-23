// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const cwd = fileURLToPath(new URL('../../', import.meta.url))
const eslint = new ESLint({
  cwd,
  overrideConfig: {
    // Snippets exercise import policy without needing a TypeScript project file.
    languageOptions: { parserOptions: { projectService: false } },
  },
})

async function importErrors(code: string, filePath = 'src/core/modules/Poll.ts') {
  const [result] = await eslint.lintText(code, { filePath })
  expect(result.fatalErrorCount).toBe(0)
  return result.messages.filter(message => message.ruleId === 'no-restricted-imports')
}

describe('protocol module import boundary', () => {
  it.each([
    "import { roomStore } from '../../stores/roomStore'",
    "import * as stores from '../../stores/roomStore'",
    "import '../../stores/roomStore'",
    "export { roomStore } from '../../stores/roomStore'",
    "export * from '../../stores/roomStore'",
    "import { roomStore } from '../../stores/index'",
    "import { roomStore } from '@fluux/sdk/stores'",
  ])('rejects a runtime store dependency: %s', async code => {
    expect(await importErrors(code)).not.toHaveLength(0)
  })

  it('also protects nested protocol modules', async () => {
    expect(await importErrors("import { roomStore } from '../../../stores/roomStore'", 'src/core/modules/nested/Module.ts')).not.toHaveLength(0)
  })

  it.each([
    "import type { IgnoredUser } from '../../stores/ignoreStore'",
    "import { type IgnoredUser } from '../../stores/ignoreStore'",
    "import { findOpenGap } from '../../stores/shared/mamGap'",
    "import type { SDKEvents } from '../types'",
  ])('allows types and pure shared helpers: %s', async code => {
    expect(await importErrors(code)).toEqual([])
  })

  it.each([
    'src/core/modules/stateSnapshot.ts',
    'src/core/modules/Poll.test.ts',
    'src/bindings/storeBindings.ts',
  ])('allows store access at its existing boundary: %s', async filePath => {
    expect(await importErrors("import { roomStore } from '../../stores/roomStore'", filePath)).toEqual([])
  })

  it('retains the existing stores-barrel restriction', async () => {
    expect(await importErrors("import { roomStore } from '../../stores'", 'src/core/modules/stateSnapshot.ts')).not.toHaveLength(0)
  })
})
