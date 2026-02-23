import { describe, it, expect } from 'vitest'
import { sanitizeMediaUrl } from './useProxiedUrl'

describe('sanitizeMediaUrl', () => {
  it('should encode & and = in URL path segments', () => {
    const url =
      'https://upload.isacloud.im:5281/file_share/019c54ed-91f2-7434-b717-6fdd8296c5b3/uuid=51B2BBEE-EAA7-4738-BEB6-F32AC33B16A2&code=001&library=1&type=3&mode=2&loc=true&cap=true.mov'
    const result = sanitizeMediaUrl(url)

    expect(result).toBe(
      'https://upload.isacloud.im:5281/file_share/019c54ed-91f2-7434-b717-6fdd8296c5b3/uuid%3D51B2BBEE-EAA7-4738-BEB6-F32AC33B16A2%26code%3D001%26library%3D1%26type%3D3%26mode%3D2%26loc%3Dtrue%26cap%3Dtrue.mov'
    )
  })

  it('should leave normal URLs unchanged', () => {
    const url = 'https://example.com/uploads/photo.jpg'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should preserve already-encoded characters', () => {
    const url = 'https://example.com/uploads/my%20photo.jpg'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should preserve query parameters', () => {
    const url = 'https://example.com/file.jpg?token=abc&expires=123'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should preserve hash fragments', () => {
    const url = 'https://example.com/file.jpg#section'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should handle URLs with port numbers', () => {
    const url = 'https://upload.example.com:5281/file.mov'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should return invalid URLs unchanged', () => {
    const invalid = 'not-a-url'
    expect(sanitizeMediaUrl(invalid)).toBe(invalid)
  })

  it('should handle root path URL', () => {
    const url = 'https://example.com/'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should be idempotent', () => {
    const url =
      'https://upload.isacloud.im:5281/file_share/uuid=FILE&code=001.mov'
    const once = sanitizeMediaUrl(url)
    const twice = sanitizeMediaUrl(once)
    expect(twice).toBe(once)
  })
})
