import { useRef, type ReactNode } from 'react'
import { useCloseOnEscape } from '@/hooks/useCloseOnEscape'

/**
 * Stand-in for a modal that closes on Escape the way ModalOverlay does (shortcut help,
 * the image lightbox): it joins the shared Escape stack with its `data-modal` root.
 */
export function EscapeModal({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useCloseOnEscape(onClose, true, ref)
  return <div ref={ref} data-modal="true">{children}</div>
}
