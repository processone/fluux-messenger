import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefCallback } from 'react'

interface VirtualizerSpacerProps {
  height: number
  contentRef: RefCallback<HTMLDivElement>
  commitLayout: (commit: () => void) => void
  children: ReactNode
}

export function VirtualizerSpacer({ height, contentRef, commitLayout, children }: VirtualizerSpacerProps) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const initialStyle = useRef({ height, position: 'relative' as const, width: '100%' }).current
  const setRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element
    contentRef(element)
  }, [contentRef])

  useLayoutEffect(() => {
    const element = elementRef.current
    const nextHeight = `${height}px`
    if (!element || element.style.height === nextHeight) return
    // A spacer shrink can clamp scrollTop before a later row commit grows the range again.
    // Observe the write synchronously, while that reduced range is still visible.
    commitLayout(() => { element.style.height = nextHeight })
  }, [height, commitLayout])

  return <div ref={setRef} data-virtualizer-spacer style={initialStyle}>{children}</div>
}
