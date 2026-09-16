import { describe, it, expect } from 'vitest'
import { encodeInvokeHeaders, encodeInvokeHeaderValue } from './tauriInvokeHeaders'

describe('encodeInvokeHeaderValue', () => {
  it('produces the base64 UTF-8 bytes the native side decodes', () => {
    // Same vector as `invoke_headers.rs`.
    expect(encodeInvokeHeaderValue('https://up.example.com/slot/Отчёт за май.pdf')).toBe(
      'aHR0cHM6Ly91cC5leGFtcGxlLmNvbS9zbG90L9Ce0YLRh9GR0YIg0LfQsCDQvNCw0LkucGRm',
    )
  })

  it('preserves existing percent-escapes', () => {
    expect(encodeInvokeHeaderValue('https://up.example.com/slot/%D1%84%20a+b.txt')).toBe(
      'aHR0cHM6Ly91cC5leGFtcGxlLmNvbS9zbG90LyVEMSU4NCUyMGErYi50eHQ=',
    )
  })
})

describe('encodeInvokeHeaders', () => {
  it('encodes every value and keeps the names', () => {
    expect(encodeInvokeHeaders({ 'x-extra-headers': '{"X-Upload-Note":"файл"}', 'x-b': '' })).toEqual({
      'x-extra-headers': 'eyJYLVVwbG9hZC1Ob3RlIjoi0YTQsNC50LsifQ==',
      'x-b': '',
    })
  })
})
