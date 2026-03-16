import { useRef, useEffect } from 'react'

/**
 * Hook for modal input fields - auto-focuses and selects input on mount.
 * Escape key handling is provided by ModalShell.
 */
export function useModalInput<T extends HTMLInputElement | HTMLTextAreaElement>() {
  const inputRef = useRef<T>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return inputRef
}
