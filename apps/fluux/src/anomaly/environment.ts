/**
 * The session's environment, as closed constants.
 *
 * A rate is only comparable against a baseline gathered under a compatible platform
 * and engine while the app was meaningfully foregrounded. WebKitGTK and Chromium
 * render and scroll at different costs for reasons that are not regressions, and a
 * backgrounded session barely renders at all. Window size remains useful context,
 * so the review reports its mix without fragmenting each machine into sparse series.
 *
 * Everything here is bucketed or mapped to a registry constant. The user-agent
 * string in particular never reaches a record: it is free text of exactly the kind
 * the registries exist to keep out, and no comparison needs its precision.
 *
 * @module Anomaly/Environment
 */
import type { PlatformOS } from '@/platform'
import type { Scalar } from './serializer'
import { ENV, TAG, type Opaque } from './values'

export interface EnvironmentInputs {
  os: PlatformOS
  userAgent: string
  /** Viewport width in px, bucketed before it is recorded. */
  width: () => number
  accounts: () => number
  /** Fraction of the digest window the document was visible, 0..1. */
  foreground: () => number
}

const PLATFORM: Readonly<Record<PlatformOS, Opaque>> = Object.freeze({
  macos: TAG.platformMacos,
  linux: TAG.platformLinux,
  windows: TAG.platformWindows,
  other: TAG.platformWeb,
})

/**
 * Engine and major version from the user-agent.
 *
 * Order matters: every Chromium UA also contains `AppleWebKit`, so testing WebKit
 * first would file every Blink session as WebKit and merge the two series this
 * exists to keep apart. Chrome is therefore checked first, and its own version is
 * read rather than the `AppleWebKit/537.36` compatibility token every Blink build
 * freezes at.
 */
function engineOf(userAgent: string): { engine: Opaque; version: number } {
  const chrome = /Chrome\/(\d+)/.exec(userAgent)
  if (chrome) return { engine: TAG.engineBlink, version: Number(chrome[1]) }
  const webkit = /AppleWebKit\/(\d+)/.exec(userAgent)
  if (webkit) return { engine: TAG.engineWebkit, version: Number(webkit[1]) }
  const gecko = /Firefox\/(\d+)/.exec(userAgent)
  if (gecko) return { engine: TAG.engineGecko, version: Number(gecko[1]) }
  // A constant, not the string. An engine we cannot place is still a bucket; the
  // raw UA would be free text, and echoing it is the one thing this must not do.
  return { engine: TAG.engineUnknown, version: 0 }
}

/**
 * Tailwind's breakpoints, so a size class means the same thing here as in the UI.
 * The class is a snapshot taken when the digest flushes, not a window boundary; the
 * review reports its distribution across retained windows instead of treating one
 * endpoint sample as representative of the whole window.
 */
function sizeClassOf(width: number): Opaque {
  if (width < 640) return TAG.sizeSm
  if (width < 1024) return TAG.sizeMd
  if (width < 1536) return TAG.sizeLg
  return TAG.sizeXl
}

export function createEnvironmentReader(inputs: EnvironmentInputs): () => Array<[Opaque, Scalar]> {
  const { engine, version } = engineOf(inputs.userAgent)
  // Platform and engine are fixed for the process; only the mutable readings are
  // taken fresh, so a digest costs one UA parse per session rather than per window.
  return () => [
    [ENV.platform, PLATFORM[inputs.os] ?? TAG.platformWeb],
    [ENV.engine, engine],
    [ENV.engineVersion, version],
    [ENV.sizeClass, sizeClassOf(inputs.width())],
    [ENV.accounts, inputs.accounts()],
    [ENV.foreground, inputs.foreground()],
  ]
}

/**
 * Largest gap between observations that still counts as continuous time.
 *
 * Matches the unread detector's sampling rule, for the same reason: beyond this,
 * nothing was watching, so nothing is known about what happened. The sampler runs
 * once a second, so five seconds is five missed turns.
 */
const MAX_GAP_MS = 5_000

export interface ForegroundShare {
  /** Record a visibility transition. `visible` is the state being ENTERED. */
  note(visible: boolean, at: number): void
  /** Record that the app was still running, on the sampler's cadence. */
  sample(at: number): void
  /** Visible fraction of the OBSERVED time since the last take, then reset. */
  take(at: number): number
}

/**
 * Accumulates visible time across a digest window.
 *
 * Sampling visibility at digest time would answer a different question — whether the
 * window happened to be visible at one instant — and a session left in the
 * background all afternoon would report as foreground if someone glanced at it on
 * the tick. Only accumulation distinguishes those.
 */
export function createForegroundShare(visible: boolean, at: number): ForegroundShare {
  let current = visible
  let since = at
  let visibleMs = 0
  // Accumulated rather than derived from a window start: wall clock is the wrong
  // denominator when the WebView freezes timers. A suspended hour produces no
  // observations, and counting it as elapsed would report the active minutes that
  // follow as a mostly-background window — excluding the one stretch that ran.
  let observedMs = 0

  /** Credit the time since the last observation, bounded by what was observed. */
  function accrue(when: number): void {
    const gap = when - since
    since = when
    if (!Number.isFinite(gap) || gap <= 0) return
    // A gap past the sampling bound means nothing was watching. One step is
    // claimed, because the app was demonstrably alive at both ends; the rest is
    // unknown and is not invented in either direction.
    const observed = Math.min(gap, MAX_GAP_MS)
    observedMs += observed
    if (current) visibleMs += observed
  }

  return {
    note(next: boolean, when: number): void {
      if (next === current) return
      accrue(when)
      current = next
    },
    sample(when: number): void {
      accrue(when)
    },
    take(when: number): number {
      accrue(when)
      // A window that observed nothing is fully whatever it currently is.
      // Dividing would yield NaN, which the serializer rejects — costing the whole
      // digest its environment over an arithmetic edge case at session start.
      const share = observedMs > 0 ? visibleMs / observedMs : current ? 1 : 0
      visibleMs = 0
      observedMs = 0
      return share
    },
  }
}
