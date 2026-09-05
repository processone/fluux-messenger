/**
 * Hot-path cost of the outbound application stanza seam.
 *
 * The seam ships in `dist` to every SDK consumer, so the design makes its cost a
 * merge gate rather than a note: with no subscriber attached it must stay within
 * noise of not having the seam at all
 * (docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md §5.5).
 *
 * Four quantities, because only their differences mean anything:
 *
 * - `call` — a method of the same shape with a trivial body. The floor: what a call
 *   costs on this machine.
 * - `unsubscribed` — the real dispatcher with no handler. Its excess over `call` is
 *   what every SDK consumer pays for a seam they never use.
 * - `subscribed to another kind` — the production app shape: a session tally wants
 *   `unread-recount` while this path publishes `application-stanza-out`. It must cost
 *   the same as no subscriber because an unrelated listener cannot make this payload
 *   reachable.
 * - `subscribed` — the real dispatcher with one handler, i.e. the Dev build.
 *
 * Variants are measured in ROUNDS, interleaved, and each reports its fastest round.
 * A single pass per variant measures the JIT's warm-up order at least as much as the
 * code: run sequentially, whichever variant goes last wins, which is how a seam can
 * appear to make sending cheaper.
 *
 * The diagnostic channel is module-scoped, so a variant owns its subscription for the
 * length of its own loop rather than owning a client of its own. One subscribe and one
 * unsubscribe per round is nothing against the iteration count, and both dispatch
 * variants then run on the same client.
 *
 * Run: `npm run bench:seam -w @fluux/sdk`
 */

import { describe, it } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { XMPPClient } from '../src/core/XMPPClient'
import { subscribeDiagnostics } from '../src/diagnostics/channel'

const ITERATIONS = 1_000_000
const SENDS = 50_000
const ROUNDS = 7

interface StubTransport {
  send: (stanza: Element) => Promise<void>
  iqCaller: { request: (iq: Element) => Promise<Element> }
}

/** A client whose transport accepts everything and does nothing. */
class BenchClient extends XMPPClient {
  sink = 0

  constructor() {
    super({})
    const transport: StubTransport = {
      send: async () => {},
      iqCaller: { request: () => new Promise<Element>(() => {}) },
    }
    ;(this as unknown as { requireTransport: () => StubTransport }).requireTransport = () =>
      transport
  }

  /** The control: same call shape, and it touches the argument as the seam does. */
  noop(stanza: Element): void {
    if (stanza.name === '\0') this.sink++
  }

  dispatch(stanza: Element): void {
    ;(
      this as unknown as { emitApplicationStanzaOut: (s: Element) => void }
    ).emitApplicationStanzaOut(stanza)
  }

  send(stanza: Element): Promise<void> {
    return this.sendStanza(stanza)
  }
}

interface Variant {
  label: string
  run: () => void | Promise<void>
  ops: number
}

/** Fastest round per variant, with the variants interleaved. */
async function race(variants: Variant[]): Promise<Array<{ label: string; ns: number }>> {
  const best = new Map<string, number>()
  for (let round = 0; round <= ROUNDS; round++) {
    for (const variant of variants) {
      const started = performance.now()
      await variant.run()
      const ns = ((performance.now() - started) * 1e6) / variant.ops
      // Round 0 is warm-up for every variant alike, so it is discarded.
      if (round === 0) continue
      const previous = best.get(variant.label)
      if (previous === undefined || ns < previous) best.set(variant.label, ns)
    }
  }
  return variants.map((v) => ({ label: v.label, ns: best.get(v.label) ?? Number.NaN }))
}

function report(title: string, rows: Array<{ label: string; ns: number }>): void {
  const width = Math.max(...rows.map((r) => r.label.length))
  // Written straight to stdout: a measurement the reporter may swallow is not a
  // measurement.
  process.stdout.write(`\n${title} (fastest of ${ROUNDS} rounds)\n`)
  for (const row of rows) {
    process.stdout.write(`  ${row.label.padEnd(width)}  ${row.ns.toFixed(2)} ns/stanza\n`)
  }
}

describe('outbound seam', () => {
  it('costs nothing measurable when nobody is subscribed', async () => {
    const bare = new BenchClient()
    let seen = 0
    const stanza = xml('message', { to: 'a@example.com', id: 'x1' }, xml('body', {}, 'hello'))

    const rows = await race([
      {
        label: 'call (control)',
        ops: ITERATIONS,
        run: () => {
          for (let i = 0; i < ITERATIONS; i++) bare.noop(stanza)
        },
      },
      {
        label: 'dispatch, unsubscribed',
        ops: ITERATIONS,
        run: () => {
          for (let i = 0; i < ITERATIONS; i++) bare.dispatch(stanza)
        },
      },
      {
        label: 'dispatch, subscribed to another kind',
        ops: ITERATIONS,
        run: () => {
          // The SDK benchmark cannot import an app subscriber. A listener narrowed
          // to unread recounts is the exact production reachability shape.
          const off = subscribeDiagnostics(() => {}, { kinds: ['unread-recount'] })
          try {
            for (let i = 0; i < ITERATIONS; i++) bare.dispatch(stanza)
          } finally {
            off()
          }
        },
      },
      {
        label: 'dispatch, one subscriber',
        ops: ITERATIONS,
        run: () => {
          const off = subscribeDiagnostics(() => {
            seen++
          })
          try {
            for (let i = 0; i < ITERATIONS; i++) bare.dispatch(stanza)
          } finally {
            off()
          }
        },
      },
    ])

    report('dispatch', rows)
    process.stdout.write(`  (subscriber saw ${seen} stanzas, control sink ${bare.sink})\n`)
  })

  it('is invisible in the cost of an actual send', async () => {
    const stanza = xml('message', { to: 'a@example.com', id: 'x1' }, xml('body', {}, 'hello'))
    const client = new BenchClient()

    const sendLoop = async (): Promise<void> => {
      for (let i = 0; i < SENDS; i++) await client.send(stanza)
    }
    const subscribedSendLoop = async (): Promise<void> => {
      const off = subscribeDiagnostics(() => {})
      try {
        await sendLoop()
      } finally {
        off()
      }
    }
    const differentlySubscribedSendLoop = async (): Promise<void> => {
      const off = subscribeDiagnostics(() => {}, { kinds: ['unread-recount'] })
      try {
        await sendLoop()
      } finally {
        off()
      }
    }

    const rows = await race([
      { label: 'sendStanza, unsubscribed', ops: SENDS, run: sendLoop },
      {
        label: 'sendStanza, subscribed to another kind',
        ops: SENDS,
        run: differentlySubscribedSendLoop,
      },
      { label: 'sendStanza, one subscriber', ops: SENDS, run: subscribedSendLoop },
    ])

    report('end to end', rows)
  })
})
