import { useCallback, useEffect, useRef, useState } from 'react'

interface FireworksAnimationProps {
  onComplete: () => void
  duration?: number // Duration in ms before auto-dismiss starts
}

// Soft, slightly desaturated tricolore palette — an understated evening
// display, not saturated primaries. Shells cycle blue → white → red.
interface Hsl {
  h: number
  s: number
  l: number
}
const SHELL_HUES: Hsl[] = [
  { h: 222, s: 62, l: 68 }, // soft blue
  { h: 40, s: 28, l: 90 }, // warm white
  { h: 355, s: 62, l: 64 }, // soft red
]

type ShellKind = 'peony' | 'ring' | 'willow'
// Peony-heavy mix keeps the show classic; ring and willow add variety.
const SHELL_KINDS: ShellKind[] = ['peony', 'peony', 'ring', 'willow']

// Rocket gravity (px/frame² at 60 fps). Shells fly a ballistic arc — leaning
// sideways and decelerating into a curve — and burst at the apex (~1.1 s climb).
const ROCKET_GRAVITY = 0.25

interface Rocket {
  x: number
  y: number
  vx: number
  vy: number // px per 60fps-frame, negative = rising
  burstY: number
  color: Hsl
  kind: ShellKind
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number // 1 → 0
  decay: number // life lost per 60fps-frame
  size: number // core radius in px
  color: Hsl
  gravity: number
  drag: number
  twinkle: boolean
}

function sparkColor(c: Hsl, alpha: number, lighten = 0): string {
  return `hsla(${c.h}, ${c.s}%, ${Math.min(c.l + lighten, 96)}%, ${alpha})`
}

/** Spawn the burst for a shell. Each kind has its own spread and physics. */
function burst(sparks: Spark[], rocket: Rocket): void {
  const { x, y, color, kind } = rocket

  // Brief soft white core-flash: one big, fast-dying particle.
  sparks.push({
    x, y, vx: 0, vy: 0,
    life: 1, decay: 0.12, size: 14,
    color: { h: 40, s: 20, l: 95 },
    gravity: 0, drag: 1, twinkle: false,
  })

  if (kind === 'peony') {
    // Uniform disc: sqrt-distributed speeds fill the sphere evenly.
    const count = 70 + Math.floor(Math.random() * 20)
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 4.2 * Math.sqrt(Math.random())
      sparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1, decay: 0.009 + Math.random() * 0.005,
        size: 1.2 + Math.random() * 1.0,
        color, gravity: 0.035, drag: 0.985, twinkle: false,
      })
    }
  } else if (kind === 'ring') {
    // Even circle with slight jitter — reads as a crisp expanding ring.
    const count = 48
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.06
      const speed = 3.4 + (Math.random() - 0.5) * 0.3
      sparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1, decay: 0.011 + Math.random() * 0.004,
        size: 1.4 + Math.random() * 0.8,
        color, gravity: 0.03, drag: 0.987, twinkle: false,
      })
    }
  } else {
    // Willow: slower ejection, heavy gravity + drag → long drooping,
    // flickering embers.
    const count = 56 + Math.floor(Math.random() * 12)
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 2.6 * Math.sqrt(Math.random())
      sparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.4,
        life: 1, decay: 0.004 + Math.random() * 0.003,
        size: 1.0 + Math.random() * 0.8,
        color, gravity: 0.05, drag: 0.992, twinkle: true,
      })
    }
  }
}

export function FireworksAnimation({ onComplete, duration = 6000 }: FireworksAnimationProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isVisible, setIsVisible] = useState(true)
  // Read inside the rAF loop to stop launching new shells during fade-out,
  // and to make dismissal idempotent (click + timer must not double-fire).
  const dismissingRef = useRef(false)

  const dismiss = useCallback(() => {
    if (dismissingRef.current) return
    dismissingRef.current = true
    setIsVisible(false)
    // Give time for the CSS fade-out before unmounting.
    setTimeout(onComplete, 500)
  }, [onComplete])

  // Auto-dismiss after duration
  useEffect(() => {
    const timer = setTimeout(dismiss, duration)
    return () => clearTimeout(timer)
  }, [duration, dismiss])

  // Fireworks simulation: one canvas, one rAF loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return // headless test environments: overlay still mounts and times out

    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const rockets: Rocket[] = []
    const sparks: Spark[] = []
    let shellIndex = 0
    let untilLaunch = 250 // ms until next launch; first shell goes up quickly
    let elapsed = 0 // ms since mount, drives the finale
    let finaleDone = false
    // Bouquet final: three simultaneous tricolore peonies shortly before the
    // fade-out (climb ~1.1 s + bloom ~1.2 s fit inside the remaining window).
    const finaleAt = Math.max(0, duration - 2600)
    let last = performance.now()
    let raf = 0

    const launch = (opts?: { color?: Hsl; xFrac?: number; burstFrac?: number; kind?: ShellKind; lean?: number }) => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const burstY = h * (opts?.burstFrac ?? 0.2 + Math.random() * 0.3)
      const startY = h + 8
      // Ballistic arc: initial vy chosen so the apex lands at burstY under
      // ROCKET_GRAVITY; the sideways lean bends the climb into a curve.
      const lean = opts?.lean ?? (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.2)
      rockets.push({
        x: w * (opts?.xFrac ?? 0.2 + Math.random() * 0.6),
        y: startY,
        vx: lean,
        vy: -Math.sqrt(2 * ROCKET_GRAVITY * (startY - burstY)),
        burstY,
        color: opts?.color ?? SHELL_HUES[shellIndex++ % SHELL_HUES.length],
        kind: opts?.kind ?? SHELL_KINDS[Math.floor(Math.random() * SHELL_KINDS.length)],
      })
    }

    const frame = (now: number) => {
      const dt = Math.min(now - last, 50) // clamp background-tab jumps
      last = now
      const step = dt / 16.67 // 1.0 at 60 fps → framerate-independent physics

      const w = canvas.clientWidth
      const h = canvas.clientHeight

      // Fade the previous frame instead of clearing: sparks leave glowing
      // motion-blur trails while the canvas stays transparent over the app.
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'rgba(0, 0, 0, 0.16)'
      ctx.fillRect(0, 0, w, h)
      // Additive blending makes overlapping sparks glow.
      ctx.globalCompositeOperation = 'lighter'

      // Calm cadence: at most 2 shells airborne, none once dismissal starts.
      // Regular launches pause ahead of the finale so the bouquet reads as
      // the ending rather than blending into the stream.
      elapsed += dt
      untilLaunch -= dt
      if (!dismissingRef.current && !finaleDone && elapsed < finaleAt - 800 && untilLaunch <= 0 && rockets.length < 2) {
        launch()
        untilLaunch = 500 + Math.random() * 500
      }

      // Bouquet final: blue, white, red burst together — one shell per color,
      // spread across the sky at matching heights.
      if (!dismissingRef.current && !finaleDone && elapsed >= finaleAt) {
        finaleDone = true
        launch({ color: SHELL_HUES[0], xFrac: 0.27, burstFrac: 0.27, kind: 'peony', lean: -0.4 })
        launch({ color: SHELL_HUES[1], xFrac: 0.5, burstFrac: 0.22, kind: 'peony', lean: (Math.random() - 0.5) * 0.4 })
        launch({ color: SHELL_HUES[2], xFrac: 0.73, burstFrac: 0.27, kind: 'peony', lean: 0.4 })
      }

      // Rockets: ballistic climb, bright streak, burst at the apex of the arc.
      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i]
        r.vy += ROCKET_GRAVITY * step
        r.x += r.vx * step
        r.y += r.vy * step
        ctx.strokeStyle = sparkColor(r.color, 0.9, 18)
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(r.x - r.vx * 3, r.y - r.vy * 3)
        ctx.lineTo(r.x, r.y)
        ctx.stroke()
        // Apex ≈ vy crossing zero; burstY fallback covers frame-size rounding.
        if (r.vy >= -0.8 || r.y <= r.burstY) {
          rockets.splice(i, 1)
          burst(sparks, r)
        }
      }

      // Sparks: physics + two-pass glow draw (soft halo, bright core).
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]
        s.vx *= Math.pow(s.drag, step)
        s.vy = s.vy * Math.pow(s.drag, step) + s.gravity * step
        s.x += s.vx * step
        s.y += s.vy * step
        s.life -= s.decay * step
        if (s.life <= 0) {
          sparks.splice(i, 1)
          continue
        }
        // Dying willow embers flicker gently.
        const alpha =
          s.twinkle && s.life < 0.6 ? s.life * (0.55 + 0.45 * Math.random()) : s.life
        ctx.fillStyle = sparkColor(s.color, alpha * 0.22)
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.size * 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = sparkColor(s.color, alpha, 14)
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2)
        ctx.fill()
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [duration])

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-50 overflow-hidden transition-opacity duration-500 bg-slate-900/50 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={dismiss}
      style={{ pointerEvents: 'auto' }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* Click hint at bottom. Dark pill keeps the white text readable when
          the app behind the half-opacity scrim is in light mode. */}
      <div className="absolute bottom-8 inset-x-0 text-center">
        <span className="rounded-full bg-black/40 px-3 py-1 text-sm text-white/90">
          Click anywhere to dismiss
        </span>
      </div>
    </div>
  )
}
