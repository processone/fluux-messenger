import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const PARTICLE_COUNT = 7
const DURATION_MS = 450

interface ReactionBurstProps {
  x: number
  y: number
  onDone: () => void
}

/**
 * Renders a burst of small accent-colored particles at (x, y).
 * Particles radiate outward in evenly-spaced directions and fade out.
 * Uses CSS keyframes for performance — no JS animation loop.
 * Rendered via portal to escape overflow:hidden containers.
 */
export function ReactionBurst({ x, y, onDone }: ReactionBurstProps) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false)
      onDone()
    }, DURATION_MS)
    return () => clearTimeout(timer)
  }, [onDone])

  if (!visible) return null

  return createPortal(
    <div
      className="fixed pointer-events-none z-[9999]"
      style={{ left: x, top: y }}
    >
      {Array.from({ length: PARTICLE_COUNT }, (_, i) => {
        const angle = (360 / PARTICLE_COUNT) * i
        const distance = 18 + Math.random() * 14 // 18-32px
        return (
          <span
            key={i}
            className="absolute size-1.5 rounded-full bg-fluux-brand"
            style={{
              '--angle': `${angle}deg`,
              '--distance': `-${distance}px`,
              animation: `reaction-burst ${DURATION_MS}ms ease-out forwards`,
              animationDelay: `${i * 15}ms`,
            } as React.CSSProperties}
          />
        )
      })}
    </div>,
    document.body
  )
}
