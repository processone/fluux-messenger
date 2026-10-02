/**
 * Whether the app, rather than the OS, draws this window's chrome: the title
 * bar and its minimize, maximize and close buttons.
 *
 * {@link PlatformCapabilities.drawsWindowControls} says the build asks for a
 * frameless window. This asks the window itself, so removing the platform
 * window config brings the native frame back without leaving a second set of
 * buttons on top of it. Until the window answers, the chrome counts as native.
 *
 * @packageDocumentation
 * @module Platform
 */

import { useSyncExternalStore } from 'react'
import { platform } from './index'

let custom = false
const listeners = new Set<() => void>()

function setCustom(next: boolean): void {
  if (custom === next) return
  custom = next
  // The stylesheet keys the native drag region and the title bar inset off
  // this attribute, so it cannot disagree with what React renders.
  if (next) document.documentElement.dataset.windowChrome = 'custom'
  else delete document.documentElement.dataset.windowChrome
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Ask the window whether it has a native frame. Resolves once it has answered. */
export async function detectWindowChrome(): Promise<void> {
  if (!platform().drawsWindowControls) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    // Removing tauri.windows.conf.json restores the native frame; querying
    // decorations prevents app-drawn buttons from duplicating native buttons.
    setCustom(!(await getCurrentWindow().isDecorated()))
  } catch {
    // An unanswered query leaves the chrome native: a window without buttons
    // can still be closed from the taskbar, a window with two sets cannot be
    // trusted.
  }
}

/** True once the window has reported that it has no native frame. */
export function useCustomWindowChrome(): boolean {
  return useSyncExternalStore(subscribe, () => custom)
}

/** State the window chrome for a test, and restore it afterwards. */
export function setCustomWindowChromeForTesting(value: boolean): () => void {
  const previous = custom
  setCustom(value)
  return () => setCustom(previous)
}
