import { describe, it, expect } from 'vitest'
import { applyRetraction, applyCorrection, parseOobData, parseMessageContent, parseOriginId, parseStanzaId, createOriginIdElement, hasRenderableContent } from './messagingUtils'
import { createMockElement } from '../test-utils'

describe('messagingUtils', () => {
  describe('applyRetraction', () => {
    it('should return retraction data when sender matches', () => {
      const result = applyRetraction(true)

      expect(result).not.toBeNull()
      expect(result?.isRetracted).toBe(true)
      expect(result?.retractedAt).toBeInstanceOf(Date)
    })

    it('should return null when sender does not match', () => {
      const result = applyRetraction(false)

      expect(result).toBeNull()
    })

    it('should set retractedAt to current time', () => {
      const before = new Date()
      const result = applyRetraction(true)
      const after = new Date()

      expect(result?.retractedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(result?.retractedAt.getTime()).toBeLessThanOrEqual(after.getTime())
    })
  })

  describe('applyCorrection', () => {
    it('should return correction data with processed body', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Corrected text' },
      ])

      const result = applyCorrection(messageEl, 'Corrected text', 'Original text')

      expect(result.body).toBe('Corrected text')
      expect(result.isEdited).toBe(true)
      expect(result.originalBody).toBe('Original text')
    })

    it('should preserve original body from first message', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Second correction' },
      ])

      // Simulating a message that was already corrected once
      const result = applyCorrection(messageEl, 'Second correction', 'Very first text')

      expect(result.originalBody).toBe('Very first text')
    })

    it('should include attachment when present in correction', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Check this file' },
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/file.pdf' },
          ],
        },
      ])

      const result = applyCorrection(messageEl, 'Check this file', 'Original text')

      expect(result.attachment).toBeDefined()
      expect(result.attachment?.url).toBe('https://example.com/file.pdf')
    })

    it('should not include attachment when not present', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Just text' },
      ])

      const result = applyCorrection(messageEl, 'Just text', 'Original')

      expect(result.attachment).toBeUndefined()
    })

    it('should handle correction with timestamp from delay element', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Corrected text' },
        { name: 'delay', attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' } },
      ])

      const result = applyCorrection(messageEl, 'Corrected text', 'Original text')

      // applyCorrection doesn't return timestamp, that's part of the message metadata
      expect(result.body).toBe('Corrected text')
      expect(result.isEdited).toBe(true)
    })
  })

  describe('parseOobData', () => {
    it('should detect video mediaType from extension even with image thumbnail', () => {
      // This is a regression test: videos with thumbnails were incorrectly
      // detected as images because thumbnail.mediaType (image/jpeg) was used
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/uploads/video.mp4' },
            {
              name: 'thumbnail',
              attrs: {
                xmlns: 'urn:xmpp:thumbs:1',
                uri: 'cid:sha1+abc123@bob.xmpp.org',
                'media-type': 'image/jpeg',
                width: '320',
                height: '240',
              },
            },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result).toBeDefined()
      expect(result?.mediaType).toBe('video/mp4')
      expect(result?.thumbnail).toBeDefined()
      expect(result?.thumbnail?.mediaType).toBe('image/jpeg')
    })

    it('should detect webm video with thumbnail', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/video.webm' },
            {
              name: 'thumbnail',
              attrs: {
                xmlns: 'urn:xmpp:thumbs:1',
                uri: 'cid:sha1+xyz@bob.xmpp.org',
                'media-type': 'image/png',
                width: '160',
                height: '120',
              },
            },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.mediaType).toBe('video/webm')
    })

    it('should detect mov video with thumbnail', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/movie.mov' },
            {
              name: 'thumbnail',
              attrs: {
                xmlns: 'urn:xmpp:thumbs:1',
                uri: 'cid:thumb@xmpp.org',
                'media-type': 'image/jpeg',
                width: '640',
                height: '480',
              },
            },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.mediaType).toBe('video/quicktime')
    })

    it('should detect image mediaType correctly', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/photo.jpg' },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.mediaType).toBe('image/jpeg')
    })

    it('should detect audio mediaType correctly', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/song.mp3' },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.mediaType).toBe('audio/mpeg')
    })

    it('should return undefined mediaType for unknown extension', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/file.xyz' },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result).toBeDefined()
      expect(result?.mediaType).toBeUndefined()
    })

    it('should return undefined when no OOB element', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'No attachment' },
      ])

      const result = parseOobData(stanza)

      expect(result).toBeUndefined()
    })

    it('should extract filename from URL', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/uploads/my-document.pdf' },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.name).toBe('my-document.pdf')
      expect(result?.mediaType).toBe('application/pdf')
    })

    it('should use description as name when provided', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/file.pdf' },
            { name: 'desc', text: 'Important Document' },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.name).toBe('Important Document')
    })

    it('should extract XEP-0446 file metadata dimensions', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/photo.jpg' },
          ],
        },
        {
          name: 'file',
          attrs: { xmlns: 'urn:xmpp:file:metadata:0' },
          children: [
            { name: 'media-type', text: 'image/jpeg' },
            { name: 'name', text: 'vacation-photo.jpg' },
            { name: 'size', text: '1024000' },
            { name: 'width', text: '1920' },
            { name: 'height', text: '1080' },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result).toBeDefined()
      expect(result?.width).toBe(1920)
      expect(result?.height).toBe(1080)
      expect(result?.size).toBe(1024000)
      expect(result?.name).toBe('vacation-photo.jpg')
      expect(result?.mediaType).toBe('image/jpeg')
    })

    it('should prefer XEP-0446 media-type over URL extension', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/file.unknown' },
          ],
        },
        {
          name: 'file',
          attrs: { xmlns: 'urn:xmpp:file:metadata:0' },
          children: [
            { name: 'media-type', text: 'image/png' },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.mediaType).toBe('image/png')
    })

    it('should work with XEP-0446 and XEP-0264 thumbnail together', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/photo.jpg' },
            {
              name: 'thumbnail',
              attrs: {
                xmlns: 'urn:xmpp:thumbs:1',
                uri: 'https://example.com/thumb.jpg',
                'media-type': 'image/jpeg',
                width: '256',
                height: '144',
              },
            },
          ],
        },
        {
          name: 'file',
          attrs: { xmlns: 'urn:xmpp:file:metadata:0' },
          children: [
            { name: 'width', text: '3840' },
            { name: 'height', text: '2160' },
          ],
        },
      ])

      const result = parseOobData(stanza)

      // Original dimensions from XEP-0446
      expect(result?.width).toBe(3840)
      expect(result?.height).toBe(2160)
      // Thumbnail dimensions from XEP-0264
      expect(result?.thumbnail?.width).toBe(256)
      expect(result?.thumbnail?.height).toBe(144)
    })

    it('should handle XEP-0446 with only partial metadata', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://example.com/video.mp4' },
          ],
        },
        {
          name: 'file',
          attrs: { xmlns: 'urn:xmpp:file:metadata:0' },
          children: [
            { name: 'width', text: '1280' },
            // height is missing
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.width).toBe(1280)
      expect(result?.height).toBeUndefined()
      expect(result?.mediaType).toBe('video/mp4') // Falls back to URL extension
    })

    it('should parse aesgcm:// thumbnail URI into HTTPS URL and encryption params', () => {
      // Regression: thumbnail aesgcm:// URIs were stored raw, so useAttachmentUrl
      // received no encryption params and fell back to useProxiedUrl which can't
      // decode them — encrypted thumbnails never rendered.
      const iv = 'aabbccddeeff001122334455' // 24 hex = 12 bytes
      const key = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20' // 64 hex = 32 bytes
      const aesgcmThumbUri = `aesgcm://upload.example.com/thumb.bin#${iv}${key}`
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://upload.example.com/image.bin' },
            {
              name: 'thumbnail',
              attrs: {
                xmlns: 'urn:xmpp:thumbs:1',
                uri: aesgcmThumbUri,
                'media-type': 'image/jpeg',
                width: '320',
                height: '240',
              },
            },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.thumbnail).toBeDefined()
      // URI must be the HTTPS URL — never the raw aesgcm:// URI
      expect(result?.thumbnail?.uri).toBe('https://upload.example.com/thumb.bin')
      // Encryption params must be populated so the UI can decrypt
      expect(result?.thumbnail?.encryption).toBeDefined()
      expect(result?.thumbnail?.encryption?.cipher).toBe('aes-256-gcm')
      expect(result?.thumbnail?.encryption?.iv).toBeInstanceOf(Uint8Array)
      expect(result?.thumbnail?.encryption?.key).toBeInstanceOf(Uint8Array)
      expect(result?.thumbnail?.encryption?.iv.length).toBe(12)
      expect(result?.thumbnail?.encryption?.key.length).toBe(32)
    })

    it('should not set encryption on plain HTTPS thumbnail URI', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: 'https://upload.example.com/image.jpg' },
            {
              name: 'thumbnail',
              attrs: {
                xmlns: 'urn:xmpp:thumbs:1',
                uri: 'https://upload.example.com/thumb.jpg',
                'media-type': 'image/jpeg',
                width: '320',
                height: '240',
              },
            },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result?.thumbnail?.uri).toBe('https://upload.example.com/thumb.jpg')
      expect(result?.thumbnail?.encryption).toBeUndefined()
    })

    it('should handle Prosody http_file_share URL with & and = in path', () => {
      const url = 'https://upload.isacloud.im:5281/file_share/019c54ed-91f2-7434-b717-6fdd8296c5b3/uuid=51B2BBEE-EAA7-4738-BEB6-F32AC33B16A2&code=001&library=1&type=3&mode=2&loc=true&cap=true.mov'
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [
            { name: 'url', text: url },
          ],
        },
      ])

      const result = parseOobData(stanza)

      expect(result).toBeDefined()
      expect(result?.url).toBe(url)
      expect(result?.mediaType).toBe('video/quicktime')
      expect(result?.name).toBe(
        'uuid=51B2BBEE-EAA7-4738-BEB6-F32AC33B16A2&code=001&library=1&type=3&mode=2&loc=true&cap=true.mov'
      )
    })
  })

  describe('parseOriginId (XEP-0359)', () => {
    it('should parse origin-id from message element', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
        { name: 'origin-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'origin-abc-123' } },
      ])

      expect(parseOriginId(stanza)).toBe('origin-abc-123')
    })

    it('should return undefined when no origin-id element', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
      ])

      expect(parseOriginId(stanza)).toBeUndefined()
    })

    it('should return undefined when origin-id has wrong namespace', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'origin-id', attrs: { xmlns: 'wrong:namespace', id: 'some-id' } },
      ])

      expect(parseOriginId(stanza)).toBeUndefined()
    })

    it('should return undefined when origin-id has no id attribute', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'origin-id', attrs: { xmlns: 'urn:xmpp:sid:0' } },
      ])

      expect(parseOriginId(stanza)).toBeUndefined()
    })
  })

  describe('parseStanzaId (XEP-0359 by-aware)', () => {
    it('returns the first stanza-id id when no expected by is given', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'first-id', by: 'muc.example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'second-id', by: 'user@example.com' } },
      ])

      expect(parseStanzaId(stanza)).toBe('first-id')
    })

    it('prefers the stanza-id whose by matches the expected archive (foreign first, own second)', () => {
      // Per XEP-0359/0313 a message can carry multiple <stanza-id by="..."/>.
      // Only the id stamped by the queried archive is a valid MAM cursor.
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'foreign-id', by: 'muc.example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'own-id', by: 'user@example.com' } },
      ])

      expect(parseStanzaId(stanza, 'user@example.com')).toBe('own-id')
    })

    it('compares by-attribute on a bare-JID basis', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'foreign-id', by: 'muc.example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'own-id', by: 'user@example.com' } },
      ])

      // Caller may pass a full JID; matching is on the bare form.
      expect(parseStanzaId(stanza, 'user@example.com/resource')).toBe('own-id')
    })

    it('falls back to the first stanza-id when no by matches the expected archive', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'foreign-id', by: 'muc.example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'other-id', by: 'other.example.com' } },
      ])

      expect(parseStanzaId(stanza, 'user@example.com')).toBe('foreign-id')
    })

    it('returns undefined when there is no stanza-id element', () => {
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
      ])

      expect(parseStanzaId(stanza, 'user@example.com')).toBeUndefined()
    })

    it('matches the expected archive even when it is the first stanza-id (order-independent)', () => {
      // The matching id comes FIRST here — guards against a regression that
      // simply returns the last stanza-id instead of the by-matched one.
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'own-id', by: 'user@example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'foreign-id', by: 'muc.example.com' } },
      ])

      expect(parseStanzaId(stanza, 'user@example.com')).toBe('own-id')
    })

    it('skips a by-matching stanza-id that has no id attribute and falls back to a usable id', () => {
      // A malformed <stanza-id by="me"/> with no id must not shadow a real id.
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', by: 'user@example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'foreign-id', by: 'muc.example.com' } },
      ])

      expect(parseStanzaId(stanza, 'user@example.com')).toBe('foreign-id')
    })

    it('treats an empty-string expectedBy like no expected archive (call-site safety)', () => {
      // Call sites pass getBareJid(getCurrentJid() ?? '') which is '' before the
      // JID is known — must not throw and must fall back to first-match.
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'first-id', by: 'muc.example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'second-id', by: 'user@example.com' } },
      ])

      expect(parseStanzaId(stanza, '')).toBe('first-id')
    })

    it('never matches a stanza-id that has no by attribute against an expected archive', () => {
      // A <stanza-id> without a by is ambiguous; it can only serve as fallback,
      // never as a by-match.
      const stanza = createMockElement('message', { id: 'msg-1' }, [
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'no-by-id' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'own-id', by: 'user@example.com' } },
      ])

      expect(parseStanzaId(stanza, 'user@example.com')).toBe('own-id')
      // With no expected archive, the first (by-less) id is returned.
      expect(parseStanzaId(stanza)).toBe('no-by-id')
    })
  })

  describe('parseMessageContent - by-aware stanza-id selection', () => {
    it('selects the stanza-id matching expectedStanzaIdBy', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'foreign-id', by: 'muc.example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'own-id', by: 'user@example.com' } },
      ])

      const result = parseMessageContent({ messageEl, body: 'Hello', expectedStanzaIdBy: 'user@example.com' })

      expect(result.stanzaId).toBe('own-id')
    })

    it('falls back to the first stanza-id when expectedStanzaIdBy is omitted', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'foreign-id', by: 'muc.example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'own-id', by: 'user@example.com' } },
      ])

      const result = parseMessageContent({ messageEl, body: 'Hello' })

      expect(result.stanzaId).toBe('foreign-id')
    })
  })

  describe('createOriginIdElement (XEP-0359)', () => {
    it('should create origin-id element with correct namespace and id', () => {
      const el = createOriginIdElement('test-uuid-123')

      expect(el.name).toBe('origin-id')
      expect(el.attrs.xmlns).toBe('urn:xmpp:sid:0')
      expect(el.attrs.id).toBe('test-uuid-123')
    })
  })

  describe('parseMessageContent - XEP-0359 origin-id', () => {
    it('should parse origin-id from message content', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
        { name: 'origin-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'origin-456' } },
      ])

      const result = parseMessageContent({ messageEl, body: 'Hello' })

      expect(result.originId).toBe('origin-456')
    })

    it('should parse both stanza-id and origin-id from same message', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'server-789', by: 'example.com' } },
        { name: 'origin-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'origin-456' } },
      ])

      const result = parseMessageContent({ messageEl, body: 'Hello' })

      expect(result.stanzaId).toBe('server-789')
      expect(result.originId).toBe('origin-456')
    })

    it('should return undefined originId when no origin-id element', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
      ])

      const result = parseMessageContent({ messageEl, body: 'Hello' })

      expect(result.originId).toBeUndefined()
    })
  })

  describe('parseMessageContent - authoredAt (E2EE envelope timestamp)', () => {
    it('uses authoredAt when supplied, overriding <delay/> and default-to-now', () => {
      // A hostile server could rewrite <delay/> on MAM replay. The
      // in-envelope timestamp, signed by the sender, is authoritative.
      // This test pins that authoredAt wins over <delay/>.
      const serverDelayStamp = '2025-01-01T00:00:00Z'
      const senderAuthored = new Date('2026-03-15T12:34:56Z')
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
        {
          name: 'delay',
          attrs: { xmlns: 'urn:xmpp:delay', stamp: serverDelayStamp },
        },
      ])

      const result = parseMessageContent({
        messageEl,
        body: 'Hello',
        authoredAt: senderAuthored,
      })

      expect(result.timestamp.toISOString()).toBe(senderAuthored.toISOString())
      // Still marked delayed — a live MAM catch-up message is historical
      // from the receiver's POV even when the authored time is signed.
      expect(result.isDelayed).toBe(true)
    })

    it('falls back to <delay/> when no authoredAt is supplied', () => {
      const stamp = '2025-01-01T00:00:00Z'
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
        { name: 'delay', attrs: { xmlns: 'urn:xmpp:delay', stamp } },
      ])

      const result = parseMessageContent({ messageEl, body: 'Hello' })

      expect(result.timestamp.toISOString()).toBe(new Date(stamp).toISOString())
      expect(result.isDelayed).toBe(true)
    })

    it('uses authoredAt even when no <delay/> is present', () => {
      const senderAuthored = new Date('2026-03-15T12:34:56Z')
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello' },
      ])

      const result = parseMessageContent({
        messageEl,
        body: 'Hello',
        authoredAt: senderAuthored,
      })

      expect(result.timestamp.toISOString()).toBe(senderAuthored.toISOString())
    })
  })

  describe('parseMessageContent - OOB URL stripping', () => {
    it('should strip OOB URL from body when body equals URL only', () => {
      const url = 'https://example.com/image.jpg'
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: url },
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [{ name: 'url', text: url }],
        },
      ])

      const result = parseMessageContent({ messageEl, body: url })

      expect(result.processedBody).toBe('')
      expect(result.attachment?.url).toBe(url)
    })

    it('should strip OOB URL from body and preserve surrounding text', () => {
      const url = 'https://example.com/image.jpg'
      const body = `Check this out! ${url}`
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: body },
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [{ name: 'url', text: url }],
        },
      ])

      const result = parseMessageContent({ messageEl, body })

      expect(result.processedBody).toBe('Check this out!')
      expect(result.attachment?.url).toBe(url)
    })

    it('should preserve body when OOB URL is not in body', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Hello, world!' },
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [{ name: 'url', text: 'https://example.com/other.jpg' }],
        },
      ])

      const result = parseMessageContent({ messageEl, body: 'Hello, world!' })

      expect(result.processedBody).toBe('Hello, world!')
    })

    it('should preserve body when there is no OOB attachment', () => {
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: 'Just text, no attachment' },
      ])

      const result = parseMessageContent({ messageEl, body: 'Just text, no attachment' })

      expect(result.processedBody).toBe('Just text, no attachment')
      expect(result.attachment).toBeUndefined()
    })

    it('should strip OOB URL when it appears at the end of body', () => {
      const url = 'https://upload.example.com/files/photo.png'
      const body = `Here is the photo: ${url}`
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: body },
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [{ name: 'url', text: url }],
        },
      ])

      const result = parseMessageContent({ messageEl, body })

      expect(result.processedBody).toBe('Here is the photo:')
    })

    it('should strip OOB URL when it appears at the start of body', () => {
      const url = 'https://example.com/video.mp4'
      const body = `${url} Check this video!`
      const messageEl = createMockElement('message', { id: 'msg-1' }, [
        { name: 'body', text: body },
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:oob' },
          children: [{ name: 'url', text: url }],
        },
      ])

      const result = parseMessageContent({ messageEl, body })

      expect(result.processedBody).toBe('Check this video!')
    })
  })

  describe('hasRenderableContent', () => {
    it('returns true when processedBody has text', () => {
      expect(hasRenderableContent({ processedBody: 'hello' })).toBe(true)
    })

    it('returns false when processedBody is empty and there is no other content', () => {
      expect(hasRenderableContent({ processedBody: '' })).toBe(false)
    })

    it('returns false when processedBody is only whitespace', () => {
      expect(hasRenderableContent({ processedBody: '   \n  ' })).toBe(false)
    })

    it('returns true for an empty body with an attachment (file-only message)', () => {
      expect(hasRenderableContent({ processedBody: '', attachment: { url: 'https://x/y.png' } })).toBe(true)
    })

    it('returns true for an empty body that carries a poll', () => {
      expect(hasRenderableContent({ processedBody: '', hasPoll: true })).toBe(true)
    })

    it('returns true for an empty body that carries a poll-closed result', () => {
      expect(hasRenderableContent({ processedBody: '', hasPollClosed: true })).toBe(true)
    })

    it('returns true for an empty body that carries encrypted content (placeholder)', () => {
      expect(hasRenderableContent({ processedBody: '', hasEncryptedContent: true })).toBe(true)
    })
  })
})
