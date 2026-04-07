import React, { useEffect, useState } from 'react'

interface ChristmasAnimationProps {
  onComplete: () => void
  duration?: number // Duration in ms before auto-dismiss
}

// Snowflake and decoration types
type ParticleType = 'snowflake' | 'star' | 'ornament' | 'candy'

interface Particle {
  id: number
  type: ParticleType
  x: number // Starting X position (%)
  delay: number // Animation delay (s)
  duration: number // Fall duration (s)
  size: number // Size in rem
  sway: number // Horizontal sway amount
}

// Particle symbols/emojis
const PARTICLES: Record<ParticleType, string[]> = {
  snowflake: ['*', '*', '*'],
  star: ['*'],
  ornament: ['*', '*', '*'],
  candy: ['*'],
}

// Generate random particles
function generateParticles(count: number): Particle[] {
  const particles: Particle[] = []

  for (let i = 0; i < count; i++) {
    // 80% snowflakes, 20% decorations
    const rand = Math.random()
    let type: ParticleType
    if (rand < 0.80) {
      type = 'snowflake'
    } else if (rand < 0.88) {
      type = 'star'
    } else if (rand < 0.95) {
      type = 'ornament'
    } else {
      type = 'candy'
    }

    particles.push({
      id: i,
      type,
      x: Math.random() * 100,
      delay: Math.random() * 3, // Staggered start over 3 seconds
      duration: 3 + Math.random() * 4, // 3-7 seconds to fall
      size: type === 'snowflake' ? 0.5 + Math.random() * 1 : 1 + Math.random() * 0.5,
      sway: 20 + Math.random() * 40, // 20-60px sway
    })
  }

  return particles
}

export function ChristmasAnimation({ onComplete, duration = 6000 }: ChristmasAnimationProps) {
  const [particles] = useState(() => generateParticles(50))
  const [isVisible, setIsVisible] = useState(true)

  // Auto-dismiss after duration
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false)
      // Give time for fade-out animation
      setTimeout(onComplete, 500)
    }, duration)

    return () => clearTimeout(timer)
  }, [duration, onComplete])

  // Click to dismiss early
  const handleClick = () => {
    setIsVisible(false)
    setTimeout(onComplete, 500)
  }

  return (
    <div
      className={`fixed inset-0 z-50 pointer-events-none overflow-hidden transition-opacity duration-500 bg-slate-900/50 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={handleClick}
      style={{ pointerEvents: 'auto' }}
    >
      {/* Particles */}
      {particles.map((particle) => {
        const symbols = PARTICLES[particle.type]
        const symbol = symbols[Math.floor(Math.random() * symbols.length)]

        return (
          <div
            key={particle.id}
            className="absolute animate-fall"
            style={{
              left: `${particle.x}%`,
              top: '-2rem',
              fontSize: `${particle.size}rem`,
              animationDuration: `${particle.duration}s`,
              animationDelay: `${particle.delay}s`,
              // Custom property for sway amount
              '--sway': `${particle.sway}px`,
            } as React.CSSProperties}
          >
            <span
              className={
                particle.type === 'snowflake'
                  ? 'text-white/80 drop-shadow-md'
                  : particle.type === 'star'
                    ? 'text-yellow-300 drop-shadow-lg'
                    : particle.type === 'ornament'
                      ? 'drop-shadow-lg'
                      : 'drop-shadow-md'
              }
            >
              {symbol}
            </span>
          </div>
        )
      })}

      {/* Festive message - briefly shown */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-4xl font-bold text-white drop-shadow-2xl animate-pulse">
          Merry Christmas!
        </div>
      </div>

      {/* Click hint at bottom */}
      <div className="absolute bottom-8 inset-x-0 text-center">
        <span className="text-white/60 text-sm">Click anywhere to dismiss</span>
      </div>
    </div>
  )
}
