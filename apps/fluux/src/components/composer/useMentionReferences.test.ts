/**
 * Intent (review R1): a mention must keep describing its own text when the
 * composer rewrites a draft the editor has just reported. Closing `:smile:`
 * before a mention is the case: the editor reports the typed colon with the
 * mention already shifted, then the composer swaps the shortcode for the emoji.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MentionReference } from '@fluux/sdk'
import { useMentionReferences } from './useMentionReferences'

const mention = (begin: number, end: number): MentionReference =>
  ({ begin, end, type: 'mention', uri: 'xmpp:team@conference.example/Bob' })

describe('useMentionReferences', () => {
  it('keeps a later mention on its text when a closed shortcode is replaced', () => {
    const setText = vi.fn()
    const { result } = renderHook(() => useMentionReferences(setText))

    const typed = 'a :smile: @Bob'
    act(() => {
      // The editor reports the typed colon with the mention already shifted.
      result.current.handleEditorEdit(typed, [mention(10, 14)])
      // Then the composer replaces the closed shortcode with the emoji.
      result.current.handleValueChange('a 😄 @Bob')
    })

    const refs = result.current.references
    expect(refs).toHaveLength(1)
    expect('a 😄 @Bob'.slice(refs[0].begin, refs[0].end)).toBe('@Bob')
  })

  it('carries earlier mentions across a mention inserted by the composer', () => {
    const { result } = renderHook(() => useMentionReferences(vi.fn()))
    act(() => result.current.handleEditorEdit('@Bob hi @Em', [mention(0, 4)]))
    act(() => result.current.insertMention('@Bob hi @Emma ', { ...mention(8, 13), uri: 'xmpp:team@conference.example/Emma' }))

    const text = '@Bob hi @Emma '
    expect(result.current.references.map((r) => text.slice(r.begin, r.end))).toEqual(['@Bob', '@Emma'])
  })
})
