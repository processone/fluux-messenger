import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { renderStyledMessage } from './messageStyles'

describe('renderStyledMessage', () => {
  // Helper to render and get text content
  const renderText = (text: string) => {
    const { container } = render(<div>{renderStyledMessage(text)}</div>)
    return container
  }

  describe('plain text', () => {
    it('renders plain text without modification', () => {
      const container = renderText('Hello world')
      expect(container.textContent).toBe('Hello world')
    })

    it('renders empty string', () => {
      const container = renderText('')
      expect(container.textContent).toBe('')
    })

    it('preserves whitespace in plain text', () => {
      const container = renderText('Hello   world')
      expect(container.textContent).toBe('Hello   world')
    })
  })

  describe('bold (*text*) - XEP-0393 style', () => {
    it('renders bold text', () => {
      const container = renderText('Hello *world*')
      expect(container.querySelector('strong')).toBeTruthy()
      expect(container.querySelector('strong')?.textContent).toBe('world')
    })

    it('renders multiple bold segments', () => {
      const container = renderText('*Hello* and *world*')
      const bolds = container.querySelectorAll('strong')
      expect(bolds).toHaveLength(2)
      expect(bolds[0].textContent).toBe('Hello')
      expect(bolds[1].textContent).toBe('world')
    })

    it('does not render bold when followed by space', () => {
      const container = renderText('Hello * world*')
      expect(container.querySelector('strong')).toBeFalsy()
    })

    it('does not render bold when preceded by space', () => {
      const container = renderText('Hello *world *')
      expect(container.querySelector('strong')).toBeFalsy()
    })
  })

  describe('bold (**text**) - Markdown style', () => {
    it('renders bold text with double asterisks', () => {
      const container = renderText('Hello **world**')
      expect(container.querySelector('strong')).toBeTruthy()
      expect(container.querySelector('strong')?.textContent).toBe('world')
    })

    it('renders multiple bold segments with double asterisks', () => {
      const container = renderText('**Hello** and **world**')
      const bolds = container.querySelectorAll('strong')
      expect(bolds).toHaveLength(2)
      expect(bolds[0].textContent).toBe('Hello')
      expect(bolds[1].textContent).toBe('world')
    })

    it('renders bold at start of message', () => {
      const container = renderText('**Important:** please read')
      expect(container.querySelector('strong')?.textContent).toBe('Important:')
    })

    it('renders bold at end of message', () => {
      const container = renderText('This is **critical**')
      expect(container.querySelector('strong')?.textContent).toBe('critical')
    })

    it('renders single character bold', () => {
      const container = renderText('Press **A** to continue')
      expect(container.querySelector('strong')?.textContent).toBe('A')
    })

    it('does not render bold when followed by space', () => {
      const container = renderText('Hello ** world**')
      expect(container.querySelector('strong')).toBeFalsy()
    })

    it('does not render bold when preceded by space', () => {
      const container = renderText('Hello **world **')
      expect(container.querySelector('strong')).toBeFalsy()
    })

    it('renders mixed XEP-0393 and Markdown bold styles', () => {
      const container = renderText('*single* and **double**')
      const bolds = container.querySelectorAll('strong')
      expect(bolds).toHaveLength(2)
      expect(bolds[0].textContent).toBe('single')
      expect(bolds[1].textContent).toBe('double')
    })

    it('handles AI-style bold formatting', () => {
      // Common pattern from AI bots
      const container = renderText('**Summary:** This is the key point. **Action required:** Please review.')
      const bolds = container.querySelectorAll('strong')
      expect(bolds).toHaveLength(2)
      expect(bolds[0].textContent).toBe('Summary:')
      expect(bolds[1].textContent).toBe('Action required:')
    })
  })

  describe('italic (_text_)', () => {
    it('renders italic text', () => {
      const container = renderText('Hello _world_')
      expect(container.querySelector('em')).toBeTruthy()
      expect(container.querySelector('em')?.textContent).toBe('world')
    })

    it('renders multiple italic segments', () => {
      const container = renderText('_Hello_ and _world_')
      const italics = container.querySelectorAll('em')
      expect(italics).toHaveLength(2)
    })

    it('does not render italic for underscores inside words', () => {
      const container = renderText('Use some_variable_name in code')
      expect(container.querySelector('em')).toBeFalsy()
      expect(container.textContent).toBe('Use some_variable_name in code')
    })

    it('does not render italic for snake_case identifiers', () => {
      const container = renderText('The function_name_here is important')
      expect(container.querySelector('em')).toBeFalsy()
    })

    it('renders italic when underscores are at word boundaries', () => {
      const container = renderText('This is _important_ stuff')
      expect(container.querySelector('em')).toBeTruthy()
      expect(container.querySelector('em')?.textContent).toBe('important')
    })
  })

  describe('strikethrough (~text~)', () => {
    it('renders strikethrough text', () => {
      const container = renderText('Hello ~world~')
      expect(container.querySelector('del')).toBeTruthy()
      expect(container.querySelector('del')?.textContent).toBe('world')
    })
  })

  describe('inline code (`text`)', () => {
    it('renders inline code', () => {
      const container = renderText('Hello `world`')
      expect(container.querySelector('code')).toBeTruthy()
      expect(container.querySelector('code')?.textContent).toBe('world')
    })

    it('renders code with special characters', () => {
      const container = renderText('Run `npm install`')
      expect(container.querySelector('code')?.textContent).toBe('npm install')
    })

    it('preserves spaces in inline code', () => {
      const container = renderText('Type `hello world`')
      expect(container.querySelector('code')?.textContent).toBe('hello world')
    })
  })

  describe('code blocks (```text```)', () => {
    it('renders code block', () => {
      const container = renderText('```\nconst x = 1\n```')
      expect(container.querySelector('pre')).toBeTruthy()
      expect(container.querySelector('pre code')).toBeTruthy()
    })

    it('preserves code block content', () => {
      const container = renderText('```\nfunction test() {\n  return 42\n}\n```')
      const code = container.querySelector('pre code')
      expect(code?.textContent).toContain('function test()')
    })
  })

  describe('blockquotes (> text)', () => {
    it('renders blockquote', () => {
      const container = renderText('> This is a quote')
      expect(container.querySelector('blockquote')).toBeTruthy()
      expect(container.querySelector('blockquote')?.textContent).toBe('This is a quote')
    })

    it('renders multi-line blockquote', () => {
      const container = renderText('> Line 1\n> Line 2')
      const quote = container.querySelector('blockquote')
      expect(quote).toBeTruthy()
      expect(quote?.textContent).toContain('Line 1')
      expect(quote?.textContent).toContain('Line 2')
    })

    it('does not treat > in middle of line as quote', () => {
      const container = renderText('x > y means greater than')
      expect(container.querySelector('blockquote')).toBeFalsy()
    })
  })

  describe('unordered lists (-, +, *)', () => {
    it('renders list with dash marker', () => {
      const container = renderText('- First item\n- Second item')
      const ul = container.querySelector('ul')
      expect(ul).toBeTruthy()
      const items = ul?.querySelectorAll('li')
      expect(items).toHaveLength(2)
      expect(items?.[0].textContent).toBe('First item')
      expect(items?.[1].textContent).toBe('Second item')
    })

    it('renders list with plus marker', () => {
      const container = renderText('+ First item\n+ Second item')
      const ul = container.querySelector('ul')
      expect(ul).toBeTruthy()
      const items = ul?.querySelectorAll('li')
      expect(items).toHaveLength(2)
    })

    it('renders list with asterisk marker', () => {
      const container = renderText('* First item\n* Second item')
      const ul = container.querySelector('ul')
      expect(ul).toBeTruthy()
      const items = ul?.querySelectorAll('li')
      expect(items).toHaveLength(2)
    })

    it('distinguishes asterisk list from bold text', () => {
      // "* item" with space after asterisk = list item
      // "*bold*" without space = bold text
      const container = renderText('* This is a list item\n*This is bold*')
      expect(container.querySelector('ul')).toBeTruthy()
      expect(container.querySelector('strong')).toBeTruthy()
    })

    it('renders single item list', () => {
      const container = renderText('- Only item')
      const ul = container.querySelector('ul')
      expect(ul).toBeTruthy()
      expect(ul?.querySelectorAll('li')).toHaveLength(1)
    })

    it('renders inline styling within list items', () => {
      const container = renderText('- Item with **bold** text\n- Item with _italic_ text')
      const items = container.querySelectorAll('li')
      expect(items[0].querySelector('strong')?.textContent).toBe('bold')
      expect(items[1].querySelector('em')?.textContent).toBe('italic')
    })

    it('renders URLs within list items', () => {
      const container = renderText('- Check https://example.com\n- Visit https://test.org')
      const items = container.querySelectorAll('li')
      expect(items[0].querySelector('a')).toBeTruthy()
      expect(items[1].querySelector('a')).toBeTruthy()
    })

    it('does not treat dash in middle of line as list', () => {
      const container = renderText('This is not - a list')
      expect(container.querySelector('ul')).toBeFalsy()
    })

    it('handles text before and after list', () => {
      const container = renderText('Intro text\n- Item 1\n- Item 2\nOutro text')
      expect(container.querySelector('ul')).toBeTruthy()
      expect(container.textContent).toContain('Intro text')
      expect(container.textContent).toContain('Outro text')
    })
  })

  describe('ordered lists (1., 2., etc.)', () => {
    it('renders numbered list', () => {
      const container = renderText('1. First item\n2. Second item\n3. Third item')
      const ol = container.querySelector('ol')
      expect(ol).toBeTruthy()
      const items = ol?.querySelectorAll('li')
      expect(items).toHaveLength(3)
      expect(items?.[0].textContent).toBe('First item')
      expect(items?.[1].textContent).toBe('Second item')
      expect(items?.[2].textContent).toBe('Third item')
    })

    it('preserves start number', () => {
      const container = renderText('5. Fifth item\n6. Sixth item')
      const ol = container.querySelector('ol')
      expect(ol?.getAttribute('start')).toBe('5')
    })

    it('renders single item ordered list', () => {
      const container = renderText('1. Only item')
      const ol = container.querySelector('ol')
      expect(ol).toBeTruthy()
      expect(ol?.querySelectorAll('li')).toHaveLength(1)
    })

    it('renders inline styling within ordered list items', () => {
      const container = renderText('1. Item with **bold** text\n2. Item with `code`')
      const items = container.querySelectorAll('li')
      expect(items[0].querySelector('strong')?.textContent).toBe('bold')
      expect(items[1].querySelector('code')?.textContent).toBe('code')
    })

    it('does not treat number in middle of line as list', () => {
      const container = renderText('I have 3. things to say')
      expect(container.querySelector('ol')).toBeFalsy()
    })

    it('handles AI-style numbered instructions', () => {
      const container = renderText('Here are the steps:\n1. First, do this\n2. Then, do that\n3. Finally, finish')
      const ol = container.querySelector('ol')
      expect(ol).toBeTruthy()
      expect(ol?.querySelectorAll('li')).toHaveLength(3)
    })
  })

  describe('mixed lists and other block elements', () => {
    it('handles unordered list followed by ordered list', () => {
      const container = renderText('- Bullet 1\n- Bullet 2\n1. Number 1\n2. Number 2')
      expect(container.querySelector('ul')).toBeTruthy()
      expect(container.querySelector('ol')).toBeTruthy()
    })

    it('handles blockquote followed by list', () => {
      const container = renderText('> Quote here\n- List item')
      expect(container.querySelector('blockquote')).toBeTruthy()
      expect(container.querySelector('ul')).toBeTruthy()
    })

    it('handles list followed by blockquote', () => {
      const container = renderText('- List item\n> Quote here')
      expect(container.querySelector('ul')).toBeTruthy()
      expect(container.querySelector('blockquote')).toBeTruthy()
    })

    it('handles complex mixed content', () => {
      const text = `Here's a summary:

- First point
- Second point

Steps to follow:
1. Do this
2. Do that

> Important note`
      const container = renderText(text)
      expect(container.querySelector('ul')).toBeTruthy()
      expect(container.querySelector('ol')).toBeTruthy()
      expect(container.querySelector('blockquote')).toBeTruthy()
    })
  })

  describe('URLs', () => {
    it('renders URLs as links', () => {
      const container = renderText('Visit https://example.com')
      const link = container.querySelector('a')
      expect(link).toBeTruthy()
      expect(link?.href).toBe('https://example.com/')
      expect(link?.textContent).toBe('https://example.com')
    })

    it('renders multiple URLs', () => {
      const container = renderText('See https://a.com and https://b.com')
      const links = container.querySelectorAll('a')
      expect(links).toHaveLength(2)
    })

    it('renders http URLs', () => {
      const container = renderText('Visit http://example.com')
      const link = container.querySelector('a')
      expect(link?.href).toBe('http://example.com/')
    })

    it('sets target="_blank" on links', () => {
      const container = renderText('Visit https://example.com')
      const link = container.querySelector('a')
      expect(link?.target).toBe('_blank')
    })

    it('sets rel="noopener noreferrer" on links', () => {
      const container = renderText('Visit https://example.com')
      const link = container.querySelector('a')
      expect(link?.rel).toBe('noopener noreferrer')
    })

    it('excludes trailing > from angle-bracketed URLs', () => {
      const container = renderText('See <https://github.com/issues/123>')
      const link = container.querySelector('a')
      expect(link).toBeTruthy()
      expect(link?.href).toBe('https://github.com/issues/123')
      expect(link?.textContent).toBe('https://github.com/issues/123')
      // The > should be text, not part of the link
      expect(container.textContent).toContain('>')
    })

    it('handles angle-bracketed URL with fragment', () => {
      const container = renderText('Check <https://github.com/org/repo/issues/3397#issuecomment-123>')
      const link = container.querySelector('a')
      expect(link?.href).toBe('https://github.com/org/repo/issues/3397#issuecomment-123')
      expect(link?.textContent).not.toContain('>')
    })
  })

  describe('@mentions', () => {
    it('renders @mention as highlighted span', () => {
      const container = renderText('Hello @alice!')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention).toBeTruthy()
      expect(mention?.textContent).toBe('@alice')
    })

    it('renders multiple mentions', () => {
      const container = renderText('@alice and @bob please review')
      const mentions = container.querySelectorAll('span.text-fluux-brand')
      expect(mentions).toHaveLength(2)
      expect(mentions[0].textContent).toBe('@alice')
      expect(mentions[1].textContent).toBe('@bob')
    })

    it('renders @all mention', () => {
      const container = renderText('Hey @all, meeting in 5 minutes!')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention).toBeTruthy()
      expect(mention?.textContent).toBe('@all')
    })

    it('renders mention at start of message', () => {
      const container = renderText('@alice check this out')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention).toBeTruthy()
      expect(mention?.textContent).toBe('@alice')
    })

    it('renders mention at end of message', () => {
      const container = renderText('Thanks @alice')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention).toBeTruthy()
      expect(mention?.textContent).toBe('@alice')
    })

    it('does not render email addresses as mentions', () => {
      const container = renderText('Contact me at user@example.com')
      // The @example part should not be styled as a mention when part of email
      expect(container.textContent).toContain('user@example.com')
    })

    it('renders mentions with URLs correctly', () => {
      const container = renderText('@alice check https://example.com')
      expect(container.querySelector('span.text-fluux-brand')).toBeTruthy()
      expect(container.querySelector('a')).toBeTruthy()
    })

    it('renders mentions with styled text', () => {
      const container = renderText('@alice this is *important*')
      expect(container.querySelector('span.text-fluux-brand')).toBeTruthy()
      expect(container.querySelector('strong')).toBeTruthy()
    })

    it('uses XEP-0372 mention ranges when provided', () => {
      const mentions = [
        { begin: 4, end: 10, type: 'mention' as const, uri: 'xmpp:room@conf/alice' }
      ]
      const { container } = render(<div>{renderStyledMessage('Hey @alice, check this!', mentions)}</div>)
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention).toBeTruthy()
      expect(mention?.textContent).toBe('@alice')
    })

    it('uses XEP-0372 ranges for multiple mentions', () => {
      const mentions = [
        { begin: 0, end: 4, type: 'mention' as const, uri: 'xmpp:room@conf/bob' },
        { begin: 9, end: 15, type: 'mention' as const, uri: 'xmpp:room@conf/carol' }
      ]
      const { container } = render(<div>{renderStyledMessage('@bob and @carol please', mentions)}</div>)
      const mentionSpans = container.querySelectorAll('span.text-fluux-brand')
      expect(mentionSpans).toHaveLength(2)
      expect(mentionSpans[0].textContent).toBe('@bob')
      expect(mentionSpans[1].textContent).toBe('@carol')
    })

    // Unicode nickname support (regression tests)
    it('renders mention with accented characters', () => {
      const container = renderText('@Jérôme is here')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention).toBeTruthy()
      expect(mention?.textContent).toBe('@Jérôme')
    })

    it('renders mention with German umlauts', () => {
      const container = renderText('Hello @Müller')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention?.textContent).toBe('@Müller')
    })

    it('renders mention with Spanish characters', () => {
      const container = renderText('Hola @Señorita')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention?.textContent).toBe('@Señorita')
    })

    it('renders mention with Cyrillic characters', () => {
      const container = renderText('Привет @Иван')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention?.textContent).toBe('@Иван')
    })

    it('renders mention with Chinese characters', () => {
      const container = renderText('你好 @小明')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention?.textContent).toBe('@小明')
    })

    it('renders mention with Japanese characters', () => {
      const container = renderText('@田中さん please check')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention?.textContent).toBe('@田中さん')
    })

    it('renders mention with Arabic characters', () => {
      const container = renderText('مرحبا @محمد')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention?.textContent).toBe('@محمد')
    })

    it('renders mention with mixed Unicode and ASCII', () => {
      const container = renderText('@José123 joined')
      const mention = container.querySelector('span.text-fluux-brand')
      expect(mention?.textContent).toBe('@José123')
    })

    it('renders multiple Unicode mentions', () => {
      const container = renderText('@Jérôme et @François sont là')
      const mentions = container.querySelectorAll('span.text-fluux-brand')
      expect(mentions).toHaveLength(2)
      expect(mentions[0].textContent).toBe('@Jérôme')
      expect(mentions[1].textContent).toBe('@François')
    })
  })

  describe('escape sequences', () => {
    it('escapes asterisks', () => {
      const container = renderText('Use \\*not bold\\*')
      expect(container.querySelector('strong')).toBeFalsy()
      expect(container.textContent).toContain('*not bold*')
    })

    it('escapes double asterisks', () => {
      const container = renderText('Use \\*\\*not bold\\*\\*')
      expect(container.querySelector('strong')).toBeFalsy()
      expect(container.textContent).toContain('**not bold**')
    })

    it('escapes underscores', () => {
      const container = renderText('Use \\_not italic\\_')
      expect(container.querySelector('em')).toBeFalsy()
      expect(container.textContent).toContain('_not italic_')
    })

    it('escapes tildes', () => {
      const container = renderText('Use \\~not strike\\~')
      expect(container.querySelector('del')).toBeFalsy()
      expect(container.textContent).toContain('~not strike~')
    })

    it('escapes backticks', () => {
      const container = renderText('Use \\`not code\\`')
      expect(container.querySelector('code')).toBeFalsy()
      expect(container.textContent).toContain('`not code`')
    })
  })

  describe('combined styles', () => {
    it('renders multiple different styles', () => {
      const container = renderText('*bold* and _italic_ and `code`')
      expect(container.querySelector('strong')).toBeTruthy()
      expect(container.querySelector('em')).toBeTruthy()
      expect(container.querySelector('code')).toBeTruthy()
    })

    it('renders styled text with URLs', () => {
      const container = renderText('Check *this* at https://example.com')
      expect(container.querySelector('strong')).toBeTruthy()
      expect(container.querySelector('a')).toBeTruthy()
    })

    it('renders Markdown bold with other styles', () => {
      const container = renderText('**bold** and _italic_ and ~strike~')
      expect(container.querySelector('strong')?.textContent).toBe('bold')
      expect(container.querySelector('em')).toBeTruthy()
      expect(container.querySelector('del')).toBeTruthy()
    })

    it('renders Markdown bold with URLs', () => {
      const container = renderText('Check **this** at https://example.com')
      expect(container.querySelector('strong')?.textContent).toBe('this')
      expect(container.querySelector('a')).toBeTruthy()
    })
  })

  describe('edge cases', () => {
    it('handles single character bold', () => {
      const container = renderText('*a*')
      expect(container.querySelector('strong')?.textContent).toBe('a')
    })

    it('handles styling at start of text', () => {
      const container = renderText('*bold* text')
      expect(container.querySelector('strong')?.textContent).toBe('bold')
    })

    it('handles styling at end of text', () => {
      const container = renderText('text *bold*')
      expect(container.querySelector('strong')?.textContent).toBe('bold')
    })

    it('handles newlines', () => {
      const container = renderText('Line 1\nLine 2')
      expect(container.textContent).toContain('Line 1')
      expect(container.textContent).toContain('Line 2')
    })

    it('handles mixed content with newlines', () => {
      const container = renderText('*bold*\n_italic_')
      expect(container.querySelector('strong')).toBeTruthy()
      expect(container.querySelector('em')).toBeTruthy()
    })
  })
})

describe('newline handling', () => {
  const renderText = (text: string) => {
    const { container } = render(<div>{renderStyledMessage(text)}</div>)
    return container
  }

  it('renders simple multiline text with br elements', () => {
    const container = renderText('Line 1\nLine 2')
    const brs = container.querySelectorAll('br')
    expect(brs.length).toBeGreaterThanOrEqual(1)
  })

  it('renders three lines correctly', () => {
    const container = renderText('A\nB\nC')
    expect(container.textContent).toBe('ABC')
    const brs = container.querySelectorAll('br')
    expect(brs).toHaveLength(2)
  })

  it('preserves empty lines', () => {
    const container = renderText('Line 1\n\nLine 3')
    // Should have 2 br elements (after Line 1, after empty line)
    const brs = container.querySelectorAll('br')
    expect(brs.length).toBeGreaterThanOrEqual(2)
  })
})

describe('CRLF handling', () => {
  const renderText = (text: string) => {
    const { container } = render(<div>{renderStyledMessage(text)}</div>)
    return container
  }

  it('handles CRLF (Windows-style) line endings with br', () => {
    const container = renderText('Line 1\r\nLine 2')
    expect(container.textContent).toContain('Line 1')
    expect(container.textContent).toContain('Line 2')
    expect(container.querySelectorAll('br')).toHaveLength(1)
  })

  it('handles CR only line endings with br', () => {
    const container = renderText('Line 1\rLine 2')
    expect(container.textContent).toContain('Line 1')
    expect(container.textContent).toContain('Line 2')
    expect(container.querySelectorAll('br')).toHaveLength(1)
  })
})
