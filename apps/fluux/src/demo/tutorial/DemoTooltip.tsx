/**
 * Floating tutorial tooltip that points at a target element.
 * Rendered via portal to avoid z-index issues.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { TutorialStep } from './types'

interface DemoTooltipProps {
  step: TutorialStep
  onSkip: () => void
  onComplete: () => void
}

const ARROW_SIZE = 8
const TOOLTIP_MARGIN = 12

export function DemoTooltip({ step, onSkip, onComplete }: DemoTooltipProps) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const [arrowStyle, setArrowStyle] = useState<React.CSSProperties>({})
  const [visible, setVisible] = useState(false)
  const [completed, setCompleted] = useState(false)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const updatePosition = useCallback(() => {
    const target = document.querySelector(step.targetSelector)
    const tooltip = tooltipRef.current
    if (!target || !tooltip) {
      setPosition(null)
      return
    }

    const targetRect = target.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let top = 0
    let left = 0
    const arrowCss: React.CSSProperties = { position: 'absolute' }

    switch (step.position) {
      case 'bottom':
        top = targetRect.bottom + TOOLTIP_MARGIN
        left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2
        arrowCss.top = -ARROW_SIZE
        arrowCss.left = '50%'
        arrowCss.transform = 'translateX(-50%)'
        arrowCss.borderLeft = `${ARROW_SIZE}px solid transparent`
        arrowCss.borderRight = `${ARROW_SIZE}px solid transparent`
        arrowCss.borderBottom = `${ARROW_SIZE}px solid rgba(0,0,0,0.85)`
        break
      case 'top':
        top = targetRect.top - tooltipRect.height - TOOLTIP_MARGIN
        left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2
        arrowCss.bottom = -ARROW_SIZE
        arrowCss.left = '50%'
        arrowCss.transform = 'translateX(-50%)'
        arrowCss.borderLeft = `${ARROW_SIZE}px solid transparent`
        arrowCss.borderRight = `${ARROW_SIZE}px solid transparent`
        arrowCss.borderTop = `${ARROW_SIZE}px solid rgba(0,0,0,0.85)`
        break
      case 'right':
        top = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2
        left = targetRect.right + TOOLTIP_MARGIN
        arrowCss.left = -ARROW_SIZE
        arrowCss.top = '50%'
        arrowCss.transform = 'translateY(-50%)'
        arrowCss.borderTop = `${ARROW_SIZE}px solid transparent`
        arrowCss.borderBottom = `${ARROW_SIZE}px solid transparent`
        arrowCss.borderRight = `${ARROW_SIZE}px solid rgba(0,0,0,0.85)`
        break
      case 'left':
        top = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2
        left = targetRect.left - tooltipRect.width - TOOLTIP_MARGIN
        arrowCss.right = -ARROW_SIZE
        arrowCss.top = '50%'
        arrowCss.transform = 'translateY(-50%)'
        arrowCss.borderTop = `${ARROW_SIZE}px solid transparent`
        arrowCss.borderBottom = `${ARROW_SIZE}px solid transparent`
        arrowCss.borderLeft = `${ARROW_SIZE}px solid rgba(0,0,0,0.85)`
        break
    }

    // Clamp to viewport
    left = Math.max(12, Math.min(left, vw - tooltipRect.width - 12))
    top = Math.max(12, Math.min(top, vh - tooltipRect.height - 12))

    setPosition({ top, left })
    setArrowStyle(arrowCss)
  }, [step.targetSelector, step.position])

  // Position and show on mount
  useEffect(() => {
    // Brief delay for entrance animation
    const showTimer = setTimeout(() => setVisible(true), 50)
    updatePosition()

    const resizeObserver = new ResizeObserver(updatePosition)
    resizeObserver.observe(document.body)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    return () => {
      clearTimeout(showTimer)
      resizeObserver.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [updatePosition])

  // Completion detection
  useEffect(() => {
    const trigger = step.completionTrigger
    let cleanup: (() => void) | undefined

    if (trigger.type === 'timeout') {
      const timer = setTimeout(() => {
        setCompleted(true)
        setTimeout(onComplete, 1200)
      }, trigger.ms)
      cleanup = () => clearTimeout(timer)
    } else if (trigger.type === 'click') {
      const handler = () => {
        setCompleted(true)
        setTimeout(onComplete, 1200)
      }
      // Use event delegation on document
      const listener = (e: Event) => {
        const target = e.target as HTMLElement
        if (target.closest(trigger.selector)) handler()
      }
      document.addEventListener('click', listener, true)
      cleanup = () => document.removeEventListener('click', listener, true)
    } else if (trigger.type === 'dom-appears') {
      const observer = new MutationObserver(() => {
        if (document.querySelector(trigger.selector)) {
          setCompleted(true)
          setTimeout(onComplete, 1200)
          observer.disconnect()
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      // Check immediately in case element already exists
      if (document.querySelector(trigger.selector)) {
        setCompleted(true)
        setTimeout(onComplete, 1200)
      }
      cleanup = () => observer.disconnect()
    } else if (trigger.type === 'navigate') {
      const check = () => {
        if (window.location.hash.startsWith(trigger.hash)) {
          setCompleted(true)
          setTimeout(onComplete, 1200)
        }
      }
      window.addEventListener('hashchange', check)
      check()
      cleanup = () => window.removeEventListener('hashchange', check)
    }

    // Max wait timeout (auto-skip safety)
    const maxTimer = setTimeout(onSkip, step.maxWaitMs ?? 30_000)

    return () => {
      cleanup?.()
      clearTimeout(maxTimer)
    }
  }, [step, onComplete, onSkip])

  const tooltipContent = (
    <div
      ref={tooltipRef}
      style={{
        position: 'fixed',
        zIndex: 99999,
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        maxWidth: 340,
        opacity: visible && position ? 1 : 0,
        transform: visible && position ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.85)',
          color: '#fff',
          borderRadius: 10,
          padding: '12px 16px',
          fontSize: 13,
          lineHeight: 1.5,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          position: 'relative',
        }}
      >
        {/* Arrow */}
        <div style={{ ...arrowStyle, width: 0, height: 0 }} />

        {/* Completion checkmark */}
        {completed && (
          <div style={{
            position: 'absolute', top: -8, right: -8,
            width: 24, height: 24, borderRadius: '50%',
            background: '#22c55e', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 'bold',
          }}>
            ✓
          </div>
        )}

        {/* Content */}
        <p style={{ margin: 0 }}>{step.content}</p>
        {step.actionHint && (
          <p style={{ margin: '6px 0 0', fontWeight: 600, color: '#60a5fa' }}>
            {step.actionHint}
          </p>
        )}

        {/* Skip button */}
        {!completed && (
          <button
            onClick={onSkip}
            style={{
              marginTop: 8,
              background: 'rgba(255,255,255,0.15)',
              border: 'none',
              color: '#aaa',
              borderRadius: 6,
              padding: '4px 12px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Skip
          </button>
        )}
      </div>
    </div>
  )

  return createPortal(tooltipContent, document.body)
}
