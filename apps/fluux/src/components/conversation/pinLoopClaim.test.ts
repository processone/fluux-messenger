import { describe, it, expect } from 'vitest'
import { createPinLoopClaim, PIN_CLAIM_STALE_MS } from './pinLoopClaim'

function fakeClock() {
  let t = 1_000
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('createPinLoopClaim', () => {
  it('is not held before any loop runs', () => {
    const clock = fakeClock()
    expect(createPinLoopClaim(clock.now).isHeld()).toBe(false)
  })

  it('is held while a loop owns the bottom, and released when it finishes', () => {
    const clock = fakeClock()
    const claim = createPinLoopClaim(clock.now)

    claim.renew()
    expect(claim.isHeld()).toBe(true)
    claim.release()
    expect(claim.isHeld()).toBe(false)
  })

  it('stays held across a long-running loop that keeps renewing', () => {
    const clock = fakeClock()
    const claim = createPinLoopClaim(clock.now)

    // A slow WebKit frame rate can stretch the 60-frame budget well past the stale window; as long
    // as frames keep arriving the claim must not expire under the running loop.
    for (let frame = 0; frame < 60; frame += 1) {
      claim.renew()
      clock.advance(PIN_CLAIM_STALE_MS / 2)
      expect(claim.isHeld()).toBe(true)
    }
  })

  // THE REGRESSION THIS TYPE EXISTS FOR. A loop dropped without its finish callback (a lease that
  // silently stopped being current mid-flight) used to latch a plain boolean forever, and a latched
  // claim suppresses every later bottom re-pin — a link-preview fastening, an attachment, a reaction
  // — for the whole life of the mounted list. That is the "it never sticks to the bottom" report.
  it('expires on its own when a loop is dropped without ever releasing it', () => {
    const clock = fakeClock()
    const claim = createPinLoopClaim(clock.now)

    claim.renew() // loop starts…
    // …and is abandoned here: no further frames, and release() is never called.
    expect(claim.isHeld()).toBe(true)

    clock.advance(PIN_CLAIM_STALE_MS + 1)

    expect(claim.isHeld()).toBe(false)
  })

  it('can be re-taken after expiry', () => {
    const clock = fakeClock()
    const claim = createPinLoopClaim(clock.now)

    claim.renew()
    clock.advance(PIN_CLAIM_STALE_MS + 1)
    expect(claim.isHeld()).toBe(false)

    claim.renew()
    expect(claim.isHeld()).toBe(true)
  })
})
