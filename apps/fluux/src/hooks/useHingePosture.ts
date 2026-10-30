import { useSyncExternalStore } from 'react'

/**
 * The hinge of a foldable iPhone, such as the iPhone Duo, as Fluux's iOS code reports it on
 * `<html>` (HingeReporter.swift, HingeLayout.swift):
 *
 * - `--fluux-device-posture`: `flat` or `folded` (half open);
 * - `--fluux-hinge-x`: a fold running top to bottom, in CSS pixels from the web view's left edge;
 * - `--fluux-hinge-y`: a fold running left to right, in CSS pixels from the web view's top edge;
 * - `--fluux-hinge-margin`: with a line, how far buttons keep from it on each side, in CSS pixels;
 *   only the style sheet reads it.
 *
 * Every other device and platform sets none of them, which reads as flat with no line.
 */
export interface HingePosture {
  folded: boolean
  /** The vertical fold line, when folded with the fold across the page (landscape). */
  x: number | null
  /** The horizontal fold line, when folded with the fold across the page (portrait). */
  y: number | null
}

const FLAT: HingePosture = { folded: false, x: null, y: null }
let snapshot: HingePosture = FLAT

function pixels(value: string): number | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value)
  return match ? Number(match[1]) : null
}

function read(): HingePosture {
  if (typeof document === 'undefined') return FLAT
  const style = document.documentElement.style
  const folded = style.getPropertyValue('--fluux-device-posture').trim() === 'folded'
  const x = folded ? pixels(style.getPropertyValue('--fluux-hinge-x')) : null
  const y = folded ? pixels(style.getPropertyValue('--fluux-hinge-y')) : null
  if (snapshot.folded !== folded || snapshot.x !== x || snapshot.y !== y) {
    snapshot = folded ? { folded, x, y } : FLAT
  }
  return snapshot
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  return () => observer.disconnect()
}

export function useHingePosture(): HingePosture {
  return useSyncExternalStore(subscribe, read, () => FLAT)
}
