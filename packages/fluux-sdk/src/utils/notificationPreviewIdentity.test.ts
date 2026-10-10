import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CHAT_SCOPE, canonicalReference, archiveReference, tierKey, resolveMessageReference } from './messageIdentity'
const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), '../../scripts/native-tests/preview-identity-fixtures.json'), 'utf8')).cases as Array<{
  messages: Array<{ uid: string; id: string; account: string; mamUid?: string; stanzaId?: string; stanzaBy?: string; originId?: string; key: string }>; target: string; resolved: string | null; batches?: unknown[][]; steps?: unknown[]
}>
describe('native preview identity parity', () => {
  for (const [index, fixture] of fixtures.entries()) it(`matches shared fixture ${index}`, () => {
    if (fixture.batches) {
      const output = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--loader', resolve(process.cwd(), '../../scripts/native-tests/sdk-ts-loader.mjs'), resolve(process.cwd(), '../../scripts/native-tests/preview-identity-oracle.mjs')], { input: JSON.stringify({ version: 1, cases: [fixture] }) }).toString())
      expect(output[0].steps).toEqual(fixture.steps)
      return
    }
    const messages = fixture.messages.flatMap(message => {
      const uid = archiveReference({ id: '', stanzaId: message.mamUid ?? (message.stanzaBy === message.account ? message.stanzaId : undefined) })
      expect(uid).toBe(message.uid)
      expect(uid ? tierKey(CHAT_SCOPE, 'stanzaId', uid) : '').toBe(message.key)
      return uid ? [{ ...message, stanzaId: uid }] : []
    })
    for (const message of messages) expect(tierKey(CHAT_SCOPE, 'stanzaId', canonicalReference(message))).toBe(message.key)
    const resolved = resolveMessageReference(messages, fixture.target, 'archive-first')
    expect(resolved?.candidates.length === 1 ? resolved.candidates[0].message.stanzaId : null).toBe(fixture.resolved)
  })
})
