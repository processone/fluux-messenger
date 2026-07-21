import { useCallback, useMemo } from 'react'
import { consoleStore } from '../stores/consoleStore'
import { useConsoleStore } from '../react/storeHooks'

/**
 * Hook for the XMPP debug console.
 *
 * Provides access to the raw XML packet log for debugging and development.
 * The console captures all incoming and outgoing XMPP stanzas.
 *
 * @returns An object containing console state and actions
 *
 * @example Toggle console visibility
 * ```tsx
 * function ConsoleToggle() {
 *   const { isOpen, toggle } = useConsole()
 *
 *   return (
 *     <button onClick={toggle}>
 *       {isOpen ? 'Hide' : 'Show'} Console
 *     </button>
 *   )
 * }
 * ```
 *
 * @example Displaying XMPP packets
 * ```tsx
 * function XmppConsole() {
 *   const { entries, clearEntries, isOpen, height, setHeight } = useConsole()
 *
 *   if (!isOpen) return null
 *
 *   return (
 *     <div style={{ height }}>
 *       <button onClick={clearEntries}>Clear</button>
 *       <ul>
 *         {entries.map((entry, i) => (
 *           <li key={i} className={entry.direction}>
 *             <span>{entry.direction === 'in' ? '←' : '→'}</span>
 *             <pre>{entry.xml}</pre>
 *             <time>{entry.timestamp.toISOString()}</time>
 *           </li>
 *         ))}
 *       </ul>
 *     </div>
 *   )
 * }
 * ```
 *
 * @example Resizable console panel
 * ```tsx
 * function ResizableConsole() {
 *   const { height, setHeight } = useConsole()
 *
 *   const handleDrag = (e: MouseEvent) => {
 *     setHeight(window.innerHeight - e.clientY)
 *   }
 *
 *   return (
 *     <div style={{ height }}>
 *       <div className="resize-handle" onMouseDown={...} />
 *       <ConsoleContent />
 *     </div>
 *   )
 * }
 * ```
 *
 * @category Hooks
 */
export function useConsole() {
  const isOpen = useConsoleStore((s) => s.isOpen)
  const height = useConsoleStore((s) => s.height)
  const entries = useConsoleStore((s) => s.entries)

  const toggle = useCallback(() => {
    consoleStore.getState().toggle()
  }, [])

  const setOpen = useCallback((open: boolean) => {
    consoleStore.getState().setOpen(open)
  }, [])

  const setHeight = useCallback((height: number) => {
    consoleStore.getState().setHeight(height)
  }, [])

  const clearEntries = useCallback(() => {
    consoleStore.getState().clearEntries()
  }, [])

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      toggle,
      setOpen,
      setHeight,
      clearEntries,
    }),
    [toggle, setOpen, setHeight, clearEntries]
  )

  // Memoize the entire return value to prevent render loops
  return useMemo(
    () => ({
      // State
      isOpen,
      height,
      entries,

      // Actions (spread memoized actions)
      ...actions,
    }),
    [isOpen, height, entries, actions]
  )
}
