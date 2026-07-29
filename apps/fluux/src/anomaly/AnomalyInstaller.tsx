/**
 * Mounts the anomaly runtime inside `XMPPProvider`, so the detectors added in
 * later stages can read the client from context. Renders nothing.
 *
 * It lives inside the provider rather than in `main.tsx` because at that level
 * there is no client — `XMPPProvider` constructs it internally.
 *
 * @module Anomaly/Installer
 */
import { useEffect } from 'react'
import { install } from './install'

export default function AnomalyInstaller(): null {
  useEffect(() => install(), [])
  return null
}
