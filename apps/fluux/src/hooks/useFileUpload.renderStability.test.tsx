import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useFileUpload } from './useFileUpload'

/**
 * Reference-stability guard for useFileUpload.
 *
 * RoomView/ChatView pass `uploadFile` and `clearError` (via a memoized
 * `uploadState` object) into the memo()'d composer. If either identity
 * changes on every render, the composer's shallow-prop memo can never
 * bail and re-renders on every room/chat-store write — defeating the
 * MUC render-decoupling work. These functions must therefore be stable
 * across renders when their inputs are stable.
 *
 * The mock returns a SINGLE, module-level `client` reference — faithful
 * to production, where `client` comes from React context (the one
 * XMPPProvider instance) and never changes between renders. With a stable
 * `client`, a correctly-memoized `uploadFile`/`clearError` must keep its
 * identity across re-renders.
 */
const stableClient = {
  discovery: {
    requestUploadSlot: vi.fn().mockResolvedValue({
      putUrl: 'https://upload.example.com/put/x',
      getUrl: 'https://upload.example.com/get/x',
    }),
  },
}

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({ client: stableClient }),
}))

vi.mock('@fluux/sdk/react', () => {
  // Stable reference, faithful to a focused Zustand selector that returns
  // the same object unless the upload service actually changes.
  const httpUploadService = { jid: 'upload.example.com', maxFileSize: 52428800 }
  return {
    useConnectionStore: (
      selector: (state: { httpUploadService: typeof httpUploadService }) => unknown,
    ) => selector({ httpUploadService }),
  }
})

vi.mock('react-i18next', () => {
  // i18next returns a stable `t` per render (absent a language change),
  // so the mock must too — otherwise it would falsely churn uploadFile's deps.
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})

describe('useFileUpload reference stability', () => {
  it('returns stable uploadFile and clearError across re-renders', () => {
    const { result, rerender } = renderHook(() => useFileUpload())

    const firstUpload = result.current.uploadFile
    const firstClear = result.current.clearError

    rerender()

    expect(result.current.uploadFile).toBe(firstUpload)
    expect(result.current.clearError).toBe(firstClear)
  })
})
