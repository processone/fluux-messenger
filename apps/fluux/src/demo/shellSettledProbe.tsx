import { useEffect, useState } from 'react'

/** The e2e boot waits on this global (e2e/harness/demoBoot.ts). */
export type ShellSettledWindow = Window & { __fluuxShellSettled?: boolean }

/** Present once ChatLayout's shell is in the DOM; the harness waits for the same nav. */
const SHELL_SELECTOR = '[data-nav="messages"]'

/**
 * e2e seam: sets `__fluuxShellSettled` once the app shell's mount effects have run.
 *
 * The shell paints before its mount effects run, and one of those effects restores the
 * view saved in session storage, replacing the current route once (ChatLayout). After a
 * reload, a harness that navigates as soon as the nav is visible can land in that gap and
 * see its route replaced by the restored one.
 *
 * React runs a commit's pending effects before it starts the next update. So once the nav
 * is in the DOM, this probe renders again, and it sets the marker from the effect of that
 * render: by then every effect of the commit that mounted the shell, the view restore
 * included, has run.
 */
export function ShellSettledProbe() {
  const [shellMounted, setShellMounted] = useState(false)

  useEffect(() => {
    if (shellMounted) {
      ;(window as ShellSettledWindow).__fluuxShellSettled = true
      return
    }
    const root = document.getElementById('root')
    if (!root) return
    if (root.querySelector(SHELL_SELECTOR)) {
      setShellMounted(true)
      return
    }
    const observer = new MutationObserver(() => {
      if (!root.querySelector(SHELL_SELECTOR)) return
      observer.disconnect()
      setShellMounted(true)
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [shellMounted])

  return null
}
