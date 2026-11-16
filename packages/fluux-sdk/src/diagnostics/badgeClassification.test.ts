import { afterEach, describe, expect, it } from 'vitest'
import { xml } from '@xmpp/client'
import { recordUnclaimedEME } from '../core/e2ee/stanzaDecrypt'
import { subscribeDiagnostics, type BadgeDecisionDiagnostic } from './channel'

// Intent: automatic diagnostics report the owner's actual classification,
// equally for live and archive callers, rather than predicting it beforehand.
let off: (() => void) | undefined
afterEach(() => off?.())
describe.each(['live', 'archive'] as const)('%s unclaimed encryption diagnostic', source => {
  it.each([
    { registered: true, control: false, outcome: 'unsupported', status: 'unsupported' },
    { registered: false, control: false, outcome: 'retry', status: 'unavailable' },
    { registered: true, control: true, outcome: 'none', status: 'discarded' },
  ])('reports $outcome as $status after classifying the first stanza', ({ registered, control, outcome, status }) => {
    const events: BadgeDecisionDiagnostic[] = []
    off = subscribeDiagnostics(event => { if (event.kind === 'badge-decision') events.push(event) }, { kinds: ['badge-decision'] })
    const wire = xml('message', { from: 'peer@example.test/device', id: 'encrypted-arrival', type: 'chat' },
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, xml('header', { sid: '42' }),
        ...(control ? [] : [xml('payload', {}, 'encoded-ciphertext')])),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'eu.siacs.conversations.axolotl' }))
    expect(recordUnclaimedEME(wire, registered, { peer: 'peer@example.test', source }).kind).toBe(outcome)
    expect(events).toEqual([expect.objectContaining({ phase: 'decrypt-complete', status, source, messageKey: expect.any(String) })])
  })
})
