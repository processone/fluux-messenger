import { useLayoutEffect, useRef } from 'react'

/** A non-interactive snapshot preserves rich message content without mounting a second live message row. */
export function SelectedMessagePreview({ source, body }: { source?: HTMLElement | null; body?: string }) {
  const previewRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const host = previewRef.current
    if (!source || !host) return
    const snapshot = source.cloneNode(true) as HTMLElement
    snapshot.querySelectorAll('[data-message-action-trigger]').forEach((node) => {
      // Preserve the metadata row's geometry without copying an actionable button.
      const spacer = document.createElement('span')
      spacer.className = node.className
      spacer.style.visibility = 'hidden'
      node.replaceWith(spacer)
    })
    // A snapshot is presentation only: no duplicate IDs, focus targets or media playback.
    for (const node of [snapshot, ...snapshot.querySelectorAll('*')]) {
      node.removeAttribute('id')
      node.removeAttribute('autoplay')
      node.removeAttribute('data-message-id')
      node.removeAttribute('data-message-row-id')
    }
    snapshot.inert = true
    snapshot.style.cssText += ';margin:0;width:100%;max-width:100%;min-width:0;visibility:visible;opacity:1;background:transparent;'
    host.replaceChildren(snapshot)
    return () => {
      host.replaceChildren()
    }
  }, [source])

  return (
    <div data-message-preview className="fluux-popover rounded-2xl" style={{ borderWidth: 0 }}>
      <div ref={previewRef} aria-hidden="true">{!source && body}</div>
      <span className="sr-only">{body}</span>
    </div>
  )
}
