import { describe, it, expect } from 'vitest'
import { getAttachmentEmoji, formatMessagePreview, stripReplyQuote, stripMessageStyling } from './messagePreview'
import type { Message, FileAttachment } from '../core/types'

describe('messagePreview', () => {
  describe('getAttachmentEmoji', () => {
    it('should return camera emoji for images', () => {
      const attachment: FileAttachment = { url: 'test.jpg', mediaType: 'image/jpeg' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📷', label: 'Photo' })
    })

    it('should return book emoji for EPUB files', () => {
      const attachment: FileAttachment = { url: 'test.epub', name: 'test.epub', mediaType: 'application/epub+zip' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📚', label: 'Book' })
    })

    it('should return video emoji for videos', () => {
      const attachment: FileAttachment = { url: 'test.mp4', mediaType: 'video/mp4' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '🎬', label: 'Video' })
    })

    it('should return audio emoji for audio files', () => {
      const attachment: FileAttachment = { url: 'test.mp3', mediaType: 'audio/mpeg' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '🎵', label: 'Audio' })
    })

    it('should return code emoji for JavaScript files', () => {
      const attachment: FileAttachment = { url: 'test.js', name: 'test.js', mediaType: 'text/javascript' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '💻', label: 'Code' })
    })

    it('should return code emoji for TypeScript files by extension', () => {
      const attachment: FileAttachment = { url: 'test.ts', name: 'test.ts' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '💻', label: 'Code' })
    })

    it('should return code emoji for Python files', () => {
      const attachment: FileAttachment = { url: 'test.py', name: 'test.py', mediaType: 'text/x-python' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '💻', label: 'Code' })
    })

    it('should return text emoji for markdown files', () => {
      const attachment: FileAttachment = { url: 'test.md', name: 'test.md' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📝', label: 'Text' })
    })

    it('should return text emoji for JSON files', () => {
      const attachment: FileAttachment = { url: 'test.json', name: 'test.json', mediaType: 'application/json' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📝', label: 'Text' })
    })

    it('should return PDF emoji for PDF files', () => {
      const attachment: FileAttachment = { url: 'test.pdf', mediaType: 'application/pdf' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📕', label: 'PDF' })
    })

    it('should return document emoji for Word files', () => {
      const attachment: FileAttachment = { url: 'test.docx', name: 'test.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📄', label: 'Document' })
    })

    it('should return spreadsheet emoji for Excel files', () => {
      const attachment: FileAttachment = { url: 'test.xlsx', name: 'test.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📊', label: 'Spreadsheet' })
    })

    it('should return presentation emoji for PowerPoint files', () => {
      const attachment: FileAttachment = { url: 'test.pptx', name: 'test.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📽️', label: 'Presentation' })
    })

    it('should return archive emoji for ZIP files', () => {
      const attachment: FileAttachment = { url: 'test.zip', name: 'test.zip', mediaType: 'application/zip' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📦', label: 'Archive' })
    })

    it('should return file emoji for unknown types', () => {
      const attachment: FileAttachment = { url: 'test.xyz', name: 'test.xyz', mediaType: 'application/octet-stream' }
      expect(getAttachmentEmoji(attachment)).toEqual({ emoji: '📎', label: 'File' })
    })
  })

  describe('formatMessagePreview', () => {
    const baseMessage: Message = {
      type: 'chat',
      id: '1',
      conversationId: 'conv1',
      from: 'user@example.com',
      body: '',
      timestamp: new Date(),
      isOutgoing: false,
    }

    it('should return body when no attachment', () => {
      const message = { ...baseMessage, body: 'Hello world' }
      expect(formatMessagePreview(message)).toBe('Hello world')
    })

    it('should return empty string when no body and no attachment', () => {
      const message = { ...baseMessage, body: '' }
      expect(formatMessagePreview(message)).toBe('')
    })

    it('should show emoji + body when attachment has body text', () => {
      const message = {
        ...baseMessage,
        body: 'Check this out',
        attachment: { url: 'photo.jpg', mediaType: 'image/jpeg' },
      }
      expect(formatMessagePreview(message)).toBe('📷 Check this out')
    })

    it('should show emoji + filename when attachment has no body', () => {
      const message = {
        ...baseMessage,
        body: '',
        attachment: { url: 'document.pdf', name: 'report.pdf', mediaType: 'application/pdf' },
      }
      expect(formatMessagePreview(message)).toBe('📕 report.pdf')
    })

    it('should show emoji + label when attachment has no body and no filename', () => {
      const message = {
        ...baseMessage,
        body: '',
        attachment: { url: 'https://example.com/file', mediaType: 'video/mp4' },
      }
      expect(formatMessagePreview(message)).toBe('🎬 Video')
    })

    it('should handle whitespace-only body as empty', () => {
      const message = {
        ...baseMessage,
        body: '   ',
        attachment: { url: 'audio.mp3', name: 'song.mp3', mediaType: 'audio/mpeg' },
      }
      expect(formatMessagePreview(message)).toBe('🎵 song.mp3')
    })

    describe('XEP-0393 styling', () => {
      it('should strip bold markup from preview', () => {
        const message = { ...baseMessage, body: 'This is *important* news' }
        expect(formatMessagePreview(message)).toBe('This is important news')
      })

      it('should strip italic markup from preview', () => {
        const message = { ...baseMessage, body: 'Read the _documentation_ first' }
        expect(formatMessagePreview(message)).toBe('Read the documentation first')
      })

      it('should strip inline code from preview', () => {
        const message = { ...baseMessage, body: 'Run `npm install` to start' }
        expect(formatMessagePreview(message)).toBe('Run npm install to start')
      })

      it('should strip styling from attachment preview', () => {
        const message = {
          ...baseMessage,
          body: 'Check this *amazing* photo',
          attachment: { url: 'photo.jpg', mediaType: 'image/jpeg' },
        }
        expect(formatMessagePreview(message)).toBe('📷 Check this amazing photo')
      })
    })

    describe('reply handling', () => {
      it('should strip quote prefix when message is a reply', () => {
        const message = {
          ...baseMessage,
          body: '> Bob: Hello there\nMy reply',
          replyTo: { id: 'original-msg-id' },
        }
        expect(formatMessagePreview(message)).toBe('My reply')
      })

      it('should strip multiple quote lines when message is a reply', () => {
        const message = {
          ...baseMessage,
          body: '> Bob: First line\n> of quoted text\nMy reply',
          replyTo: { id: 'original-msg-id' },
        }
        expect(formatMessagePreview(message)).toBe('My reply')
      })

      it('should not strip quote if not a reply', () => {
        const message = {
          ...baseMessage,
          body: '> Bob: Hello there\nMy text',
          // No replyTo
        }
        expect(formatMessagePreview(message)).toBe('> Bob: Hello there\nMy text')
      })

      it('should handle reply with already-processed body (no quote prefix)', () => {
        const message = {
          ...baseMessage,
          body: 'My reply',
          replyTo: { id: 'original-msg-id' },
        }
        expect(formatMessagePreview(message)).toBe('My reply')
      })

      it('should handle reply with attachment and quote', () => {
        const message = {
          ...baseMessage,
          body: '> Bob: Check this\nHere it is',
          attachment: { url: 'photo.jpg', mediaType: 'image/jpeg' },
          replyTo: { id: 'original-msg-id' },
        }
        expect(formatMessagePreview(message)).toBe('📷 Here it is')
      })

      it('should show attachment only if reply body is all quotes', () => {
        const message = {
          ...baseMessage,
          body: '> Bob: Hello',
          attachment: { url: 'photo.jpg', name: 'photo.jpg', mediaType: 'image/jpeg' },
          replyTo: { id: 'original-msg-id' },
        }
        expect(formatMessagePreview(message)).toBe('📷 photo.jpg')
      })
    })
  })

  describe('stripMessageStyling', () => {
    it('should strip bold markup', () => {
      expect(stripMessageStyling('This is *bold* text')).toBe('This is bold text')
    })

    it('should strip italic markup', () => {
      expect(stripMessageStyling('This is _italic_ text')).toBe('This is italic text')
    })

    it('should strip strikethrough markup', () => {
      expect(stripMessageStyling('This is ~deleted~ text')).toBe('This is deleted text')
    })

    it('should strip inline code markup', () => {
      expect(stripMessageStyling('Run `npm install` now')).toBe('Run npm install now')
    })

    it('should strip multiple styles in same message', () => {
      expect(stripMessageStyling('*bold* and _italic_ and ~strike~')).toBe('bold and italic and strike')
    })

    it('should not strip markup in the middle of words', () => {
      // Per XEP-0393, markup must be at word boundaries
      expect(stripMessageStyling('foo*bar*baz')).toBe('foo*bar*baz')
      expect(stripMessageStyling('under_score_name')).toBe('under_score_name')
    })

    it('should handle markup at start of string', () => {
      expect(stripMessageStyling('*bold* at start')).toBe('bold at start')
    })

    it('should handle markup at end of string', () => {
      expect(stripMessageStyling('end with *bold*')).toBe('end with bold')
    })

    it('should handle empty string', () => {
      expect(stripMessageStyling('')).toBe('')
    })

    it('should handle text with no markup', () => {
      expect(stripMessageStyling('Plain text message')).toBe('Plain text message')
    })

    it('should not strip unmatched markup characters', () => {
      expect(stripMessageStyling('This * is not bold')).toBe('This * is not bold')
      expect(stripMessageStyling('Price: $50_000')).toBe('Price: $50_000')
    })

    it('should handle markup followed by punctuation', () => {
      expect(stripMessageStyling('Is it *important*?')).toBe('Is it important?')
      expect(stripMessageStyling('Say _hello_!')).toBe('Say hello!')
    })

    it('should strip multi-word bold', () => {
      expect(stripMessageStyling('This is *very important* info')).toBe('This is very important info')
    })

    it('should strip multi-word italic', () => {
      expect(stripMessageStyling('Read the _fine print_ carefully')).toBe('Read the fine print carefully')
    })
  })

  describe('stripReplyQuote', () => {
    it('should strip single quote line', () => {
      expect(stripReplyQuote('> Bob: Hello\nMy reply')).toBe('My reply')
    })

    it('should strip multiple quote lines', () => {
      expect(stripReplyQuote('> Bob: Hello\n> there\nMy reply')).toBe('My reply')
    })

    it('should return text as-is if no quote prefix', () => {
      expect(stripReplyQuote('Hello world')).toBe('Hello world')
    })

    it('should return empty string if body is all quotes', () => {
      expect(stripReplyQuote('> Bob: Hello')).toBe('')
    })

    it('should handle empty input', () => {
      expect(stripReplyQuote('')).toBe('')
    })

    it('should preserve multi-line reply text', () => {
      expect(stripReplyQuote('> Quote\nLine 1\nLine 2')).toBe('Line 1\nLine 2')
    })

    it('should trim whitespace from result', () => {
      expect(stripReplyQuote('> Quote\n  My reply  \n')).toBe('My reply')
    })
  })
})
