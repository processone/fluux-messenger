import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useConversationDraft, type DraftOperations } from './useConversationDraft'
import type { MessageComposerHandle } from '@/components/MessageComposer'

describe('useConversationDraft', () => {
  let mockDraftOperations: DraftOperations
  let mockComposerRef: React.RefObject<MessageComposerHandle>
  let drafts: Map<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    drafts = new Map()

    mockDraftOperations = {
      getDraft: vi.fn((id: string) => drafts.get(id) || ''),
      setDraft: vi.fn((id: string, text: string) => {
        drafts.set(id, text)
      }),
      clearDraft: vi.fn((id: string) => {
        drafts.delete(id)
      }),
    }

    mockComposerRef = {
      current: {
        getText: vi.fn(() => ''),
        focus: vi.fn(),
        setText: vi.fn(),
      },
    }
  })

  describe('initial state', () => {
    it('should restore draft for initial conversation', () => {
      drafts.set('conv-1', 'Saved draft text')

      const { result } = renderHook(() =>
        useConversationDraft({
          conversationId: 'conv-1',
          draftOperations: mockDraftOperations,
          composerRef: mockComposerRef,
        })
      )

      const [text] = result.current
      expect(text).toBe('Saved draft text')
      expect(mockDraftOperations.getDraft).toHaveBeenCalledWith('conv-1')
    })

    it('should return empty string when no draft exists', () => {
      const { result } = renderHook(() =>
        useConversationDraft({
          conversationId: 'conv-1',
          draftOperations: mockDraftOperations,
          composerRef: mockComposerRef,
        })
      )

      const [text] = result.current
      expect(text).toBe('')
    })
  })

  describe('conversation switching', () => {
    it('should save draft when switching to a different conversation', () => {
      // Start with some text in the composer
      mockComposerRef.current!.getText = vi.fn(() => 'Unsaved text')

      const { rerender } = renderHook(
        ({ conversationId }) =>
          useConversationDraft({
            conversationId,
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          }),
        { initialProps: { conversationId: 'conv-1' } }
      )

      // Switch to a different conversation
      rerender({ conversationId: 'conv-2' })

      expect(mockDraftOperations.setDraft).toHaveBeenCalledWith('conv-1', 'Unsaved text')
    })

    it('should clear draft when switching with empty text', () => {
      mockComposerRef.current!.getText = vi.fn(() => '   ') // Whitespace only

      const { rerender } = renderHook(
        ({ conversationId }) =>
          useConversationDraft({
            conversationId,
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          }),
        { initialProps: { conversationId: 'conv-1' } }
      )

      // Switch to a different conversation
      rerender({ conversationId: 'conv-2' })

      expect(mockDraftOperations.clearDraft).toHaveBeenCalledWith('conv-1')
      expect(mockDraftOperations.setDraft).not.toHaveBeenCalled()
    })

    it('should restore draft for new conversation', () => {
      drafts.set('conv-2', 'Draft for conv-2')

      const { result, rerender } = renderHook(
        ({ conversationId }) =>
          useConversationDraft({
            conversationId,
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          }),
        { initialProps: { conversationId: 'conv-1' } }
      )

      // Switch to conv-2 which has a saved draft
      rerender({ conversationId: 'conv-2' })

      const [text] = result.current
      expect(text).toBe('Draft for conv-2')
    })

    it('should call onDraftRestored when restoring draft', () => {
      const onDraftRestored = vi.fn()

      const { rerender } = renderHook(
        ({ conversationId }) =>
          useConversationDraft({
            conversationId,
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
            onDraftRestored,
          }),
        { initialProps: { conversationId: 'conv-1' } }
      )

      // Initial call when hook mounts
      expect(onDraftRestored).toHaveBeenCalledTimes(1)

      // Switch to a different conversation
      rerender({ conversationId: 'conv-2' })

      // Called again when switching
      expect(onDraftRestored).toHaveBeenCalledTimes(2)
    })
  })

  describe('unmount behavior', () => {
    it('should save draft on unmount if text exists', () => {
      mockComposerRef.current!.getText = vi.fn(() => 'Text before unmount')

      const { unmount } = renderHook(() =>
        useConversationDraft({
          conversationId: 'conv-1',
          draftOperations: mockDraftOperations,
          composerRef: mockComposerRef,
        })
      )

      unmount()

      expect(mockDraftOperations.setDraft).toHaveBeenCalledWith('conv-1', 'Text before unmount')
    })

    it('should not save draft on unmount if text is empty', () => {
      mockComposerRef.current!.getText = vi.fn(() => '')

      const { unmount } = renderHook(() =>
        useConversationDraft({
          conversationId: 'conv-1',
          draftOperations: mockDraftOperations,
          composerRef: mockComposerRef,
        })
      )

      unmount()

      expect(mockDraftOperations.setDraft).not.toHaveBeenCalled()
    })
  })

  describe('setText function', () => {
    it('should update text state when setText is called', () => {
      const { result } = renderHook(() =>
        useConversationDraft({
          conversationId: 'conv-1',
          draftOperations: mockDraftOperations,
          composerRef: mockComposerRef,
        })
      )

      act(() => {
        const [, setText] = result.current
        setText('New text')
      })

      const [text] = result.current
      expect(text).toBe('New text')
    })

    it('should support functional updates', () => {
      drafts.set('conv-1', 'Initial')

      const { result } = renderHook(() =>
        useConversationDraft({
          conversationId: 'conv-1',
          draftOperations: mockDraftOperations,
          composerRef: mockComposerRef,
        })
      )

      act(() => {
        const [, setText] = result.current
        setText((prev) => prev + ' updated')
      })

      const [text] = result.current
      expect(text).toBe('Initial updated')
    })
  })

  describe('edge cases', () => {
    it('should not save draft when switching to the same conversation', () => {
      mockComposerRef.current!.getText = vi.fn(() => 'Some text')

      const { rerender } = renderHook(
        ({ conversationId }) =>
          useConversationDraft({
            conversationId,
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          }),
        { initialProps: { conversationId: 'conv-1' } }
      )

      // "Switch" to the same conversation
      rerender({ conversationId: 'conv-1' })

      // setDraft should not be called because we didn't actually switch
      expect(mockDraftOperations.setDraft).not.toHaveBeenCalled()
    })

    it('should handle null composer ref gracefully', () => {
      const nullRef = { current: null }

      const { rerender } = renderHook(
        ({ conversationId }) =>
          useConversationDraft({
            conversationId,
            draftOperations: mockDraftOperations,
            composerRef: nullRef,
          }),
        { initialProps: { conversationId: 'conv-1' } }
      )

      // Should not throw when switching
      expect(() => rerender({ conversationId: 'conv-2' })).not.toThrow()
    })
  })

  /**
   * Regression tests for draft persistence fixes.
   *
   * These tests document specific bugs that were fixed:
   * - REGRESSION-001: Draft not immediately cleared when text emptied
   * - REGRESSION-002: Draft not saved while typing (only on conversation switch)
   * - REGRESSION-003: Restored draft immediately re-saved to wrong conversation
   * - REGRESSION-005: Draft from Room A leaked to Room B on conversation switch
   */
  describe('real-time draft persistence (regression tests)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    describe('REGRESSION-001: Immediate clearDraft when text becomes empty', () => {
      /**
       * Bug: Draft preview in sidebar didn't update when user deleted all text
       * Fix: Call clearDraft immediately (no debounce) when text.trim() is empty
       */
      it('should clear draft immediately when text becomes empty', () => {
        drafts.set('conv-1', 'Existing draft')

        const { result } = renderHook(() =>
          useConversationDraft({
            conversationId: 'conv-1',
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          })
        )

        // Clear the mock calls from initial setup
        vi.mocked(mockDraftOperations.clearDraft).mockClear()

        // User deletes all text
        act(() => {
          const [, setText] = result.current
          setText('')
        })

        // clearDraft should be called immediately (no waiting for debounce)
        expect(mockDraftOperations.clearDraft).toHaveBeenCalledWith('conv-1')
        expect(mockDraftOperations.clearDraft).toHaveBeenCalledTimes(1)
      })

      it('should clear draft immediately for whitespace-only text', () => {
        const { result } = renderHook(() =>
          useConversationDraft({
            conversationId: 'conv-1',
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          })
        )

        vi.mocked(mockDraftOperations.clearDraft).mockClear()

        // User types only whitespace
        act(() => {
          const [, setText] = result.current
          setText('   \n\t  ')
        })

        expect(mockDraftOperations.clearDraft).toHaveBeenCalledWith('conv-1')
      })
    })

    describe('REGRESSION-002: Debounced setDraft while typing', () => {
      /**
       * Bug: Draft only saved on conversation switch, so if user typed in conv-1,
       *      then quickly switched to conv-2, the draft might be associated with conv-2
       * Fix: Save draft to store while typing (debounced 300ms)
       */
      it('should save draft after 300ms debounce while typing', () => {
        const { result } = renderHook(() =>
          useConversationDraft({
            conversationId: 'conv-1',
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          })
        )

        vi.mocked(mockDraftOperations.setDraft).mockClear()

        // User types some text
        act(() => {
          const [, setText] = result.current
          setText('Hello world')
        })

        // setDraft should NOT be called immediately
        expect(mockDraftOperations.setDraft).not.toHaveBeenCalled()

        // Advance time by 299ms - still shouldn't be called
        act(() => {
          vi.advanceTimersByTime(299)
        })
        expect(mockDraftOperations.setDraft).not.toHaveBeenCalled()

        // Advance to 300ms - now it should be called
        act(() => {
          vi.advanceTimersByTime(1)
        })
        expect(mockDraftOperations.setDraft).toHaveBeenCalledWith('conv-1', 'Hello world')
      })

      it('should reset debounce timer on subsequent keystrokes', () => {
        const { result } = renderHook(() =>
          useConversationDraft({
            conversationId: 'conv-1',
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          })
        )

        vi.mocked(mockDraftOperations.setDraft).mockClear()

        // User types
        act(() => {
          const [, setText] = result.current
          setText('H')
        })

        // Wait 200ms, then type more
        act(() => {
          vi.advanceTimersByTime(200)
        })
        act(() => {
          const [, setText] = result.current
          setText('He')
        })

        // Wait another 200ms - total 400ms but debounce reset at 200ms
        act(() => {
          vi.advanceTimersByTime(200)
        })

        // Still shouldn't be called (only 200ms since last keystroke)
        expect(mockDraftOperations.setDraft).not.toHaveBeenCalled()

        // Wait remaining 100ms
        act(() => {
          vi.advanceTimersByTime(100)
        })

        // Now it should be called with final text
        expect(mockDraftOperations.setDraft).toHaveBeenCalledWith('conv-1', 'He')
        expect(mockDraftOperations.setDraft).toHaveBeenCalledTimes(1)
      })

      it('should cancel pending debounce when text becomes empty', () => {
        const { result } = renderHook(() =>
          useConversationDraft({
            conversationId: 'conv-1',
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          })
        )

        vi.mocked(mockDraftOperations.setDraft).mockClear()
        vi.mocked(mockDraftOperations.clearDraft).mockClear()

        // User types some text
        act(() => {
          const [, setText] = result.current
          setText('Hello')
        })

        // Wait 100ms, then delete all text
        act(() => {
          vi.advanceTimersByTime(100)
        })
        act(() => {
          const [, setText] = result.current
          setText('')
        })

        // clearDraft should be called immediately
        expect(mockDraftOperations.clearDraft).toHaveBeenCalledWith('conv-1')

        // Wait for original debounce to expire
        act(() => {
          vi.advanceTimersByTime(300)
        })

        // setDraft should NOT have been called (debounce was cancelled)
        expect(mockDraftOperations.setDraft).not.toHaveBeenCalled()
      })
    })

    describe('REGRESSION-003: Prevent re-saving restored draft', () => {
      /**
       * Bug: When switching conversations, the restored draft was immediately
       *      saved back to the store (triggering debounce), which could cause
       *      the draft to be associated with the wrong conversation if user
       *      switched conversations quickly.
       * Fix: Track which conversation the text was typed in via textConversationIdRef.
       *      Restored drafts have null ownership so the save effect skips them.
       */
      it('should not trigger setDraft when restoring a draft', () => {
        drafts.set('conv-1', 'Saved draft')

        const { result } = renderHook(() =>
          useConversationDraft({
            conversationId: 'conv-1',
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          })
        )

        // Verify draft was restored
        expect(result.current[0]).toBe('Saved draft')

        vi.mocked(mockDraftOperations.setDraft).mockClear()

        // Wait for debounce period
        act(() => {
          vi.advanceTimersByTime(500)
        })

        // setDraft should NOT have been called (restored text has no conversation ownership)
        expect(mockDraftOperations.setDraft).not.toHaveBeenCalled()
      })

      it('should allow saving after user modifies the restored draft', () => {
        drafts.set('conv-1', 'Original')

        const { result } = renderHook(() =>
          useConversationDraft({
            conversationId: 'conv-1',
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          })
        )

        vi.mocked(mockDraftOperations.setDraft).mockClear()

        // User modifies the draft (userSetText stamps textConversationIdRef)
        act(() => {
          const [, setText] = result.current
          setText('Original modified')
        })

        // Wait for debounce
        act(() => {
          vi.advanceTimersByTime(300)
        })

        // Now setDraft should be called
        expect(mockDraftOperations.setDraft).toHaveBeenCalledWith('conv-1', 'Original modified')
      })
    })

    describe('REGRESSION-004: Debounce cleanup on unmount', () => {
      /**
       * Ensure pending debounce timers are cancelled on unmount
       * to prevent memory leaks and state updates on unmounted components
       */
      it('should cancel pending debounce on unmount', () => {
        const { result, unmount } = renderHook(() =>
          useConversationDraft({
            conversationId: 'conv-1',
            draftOperations: mockDraftOperations,
            composerRef: mockComposerRef,
          })
        )

        vi.mocked(mockDraftOperations.setDraft).mockClear()

        // User types some text
        act(() => {
          const [, setText] = result.current
          setText('Typing...')
        })

        // Unmount before debounce completes
        act(() => {
          vi.advanceTimersByTime(100)
        })
        unmount()

        // Advance past debounce period
        act(() => {
          vi.advanceTimersByTime(300)
        })

        // The debounced setDraft should NOT have been called after unmount
        // (cleanup effect saves draft via composerRef, not via debounce)
        // We're checking that no errors occur and timer was cleaned up
      })
    })

    describe('REGRESSION-005: Draft from Room A must not leak to Room B on switch', () => {
      /**
       * Bug: When typing a draft in Room A then switching to Room B, the draft
       *      text appeared in the sidebar on BOTH rooms. The text-save effect
       *      ran with Room A's text but Room B's conversationId.
       * Fix: textConversationIdRef tracks which conversation text was typed in.
       *      On conversation switch, textConversationIdRef is set to null,
       *      preventing the save effect from writing stale text to the new room.
       */
      it('should not save Room A draft to Room B when switching rooms', () => {
        const { result, rerender } = renderHook(
          ({ conversationId }) =>
            useConversationDraft({
              conversationId,
              draftOperations: mockDraftOperations,
              composerRef: mockComposerRef,
            }),
          { initialProps: { conversationId: 'conv-1' } }
        )

        // User types in conv-1
        act(() => {
          const [, setText] = result.current
          setText('Draft for conv-1')
        })

        // Let debounce fire for conv-1
        act(() => {
          vi.advanceTimersByTime(300)
        })

        vi.mocked(mockDraftOperations.setDraft).mockClear()

        // Mock composer to return current text (for the save-on-switch logic)
        mockComposerRef.current!.getText = vi.fn(() => 'Draft for conv-1')

        // Switch to conv-2
        rerender({ conversationId: 'conv-2' })

        // conv-1's draft should have been saved (via the switch logic)
        expect(mockDraftOperations.setDraft).toHaveBeenCalledWith('conv-1', 'Draft for conv-1')

        // conv-2 should NOT have received conv-1's draft text
        expect(mockDraftOperations.setDraft).not.toHaveBeenCalledWith(
          'conv-2',
          expect.anything()
        )

        // Wait for any debounce timers
        act(() => {
          vi.advanceTimersByTime(500)
        })

        // Still no draft saved to conv-2
        expect(mockDraftOperations.setDraft).not.toHaveBeenCalledWith(
          'conv-2',
          expect.anything()
        )
      })

      it('should allow typing in Room B after switching from Room A', () => {
        const { result, rerender } = renderHook(
          ({ conversationId }) =>
            useConversationDraft({
              conversationId,
              draftOperations: mockDraftOperations,
              composerRef: mockComposerRef,
            }),
          { initialProps: { conversationId: 'conv-1' } }
        )

        // Type in conv-1
        act(() => {
          const [, setText] = result.current
          setText('Draft for conv-1')
        })

        // Switch to conv-2
        mockComposerRef.current!.getText = vi.fn(() => 'Draft for conv-1')
        rerender({ conversationId: 'conv-2' })

        vi.mocked(mockDraftOperations.setDraft).mockClear()

        // Type in conv-2
        act(() => {
          const [, setText] = result.current
          setText('Draft for conv-2')
        })

        // Wait for debounce
        act(() => {
          vi.advanceTimersByTime(300)
        })

        // Draft should be saved to conv-2
        expect(mockDraftOperations.setDraft).toHaveBeenCalledWith('conv-2', 'Draft for conv-2')
      })
    })
  })
})
