export type CorpusCategory =
  | 'short' | 'wrap' | 'mention' | 'link' | 'emoji' | 'rtl' | 'me' | 'longtoken' | 'code' | 'mixed'

export interface CorpusItem {
  id: string
  category: CorpusCategory
  body: string
}

export const CORPUS: readonly CorpusItem[] = [
  { id: 'short-1', category: 'short', body: 'ok' },
  { id: 'short-2', category: 'short', body: 'Sounds good, thanks!' },
  { id: 'short-3', category: 'short', body: 'See you at 3.' },
  { id: 'wrap-1', category: 'wrap', body: 'This is a fairly ordinary message that should wrap onto two lines at the medium content width we test against in this harness.' },
  { id: 'wrap-2', category: 'wrap', body: 'A longer paragraph used to exercise multi-line wrapping. '.repeat(6).trim() },
  { id: 'wrap-3', category: 'wrap', body: 'First paragraph.\n\nSecond paragraph after a blank line.\n\nThird one.' },
  { id: 'wrap-edge-1', category: 'wrap', body: 'Exactly enough characters to sit right on the one to two line boundary at medium width here now.' },
  { id: 'mention-1', category: 'mention', body: '@alice can you review the deploy when you get a sec?' },
  { id: 'mention-2', category: 'mention', body: 'cc @bob @carol this is the thread we discussed earlier in standup today.' },
  { id: 'link-1', category: 'link', body: 'Docs are here https://example.com/docs/getting-started take a look.' },
  { id: 'link-2', category: 'link', body: 'https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/even/further' },
  { id: 'emoji-1', category: 'emoji', body: 'nice work 🎉🚀✅' },
  { id: 'emoji-2', category: 'emoji', body: 'family 👨‍👩‍👧‍👦 flags 🇫🇷🇯🇵 and skin tones 👍🏽👋🏿' },
  { id: 'emoji-3', category: 'emoji', body: 'a longer emoji-heavy line 😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘 wrapping across lines' },
  { id: 'rtl-1', category: 'rtl', body: 'مرحبا، هذه رسالة عربية لاختبار قياس الارتفاع' },
  { id: 'rtl-2', category: 'rtl', body: 'שלום, זו הודעה בעברית לבדיקת מדידת הגובה של השורות' },
  { id: 'me-1', category: 'me', body: '/me waves hello to the room' },
  { id: 'me-2', category: 'me', body: '/me is reviewing a very long pull request that touches the scroll machinery again and again' },
  { id: 'longtoken-1', category: 'longtoken', body: 'see supercalifragilisticexpialidocioussupercalifragilisticexpialidocious now' },
  { id: 'longtoken-2', category: 'longtoken', body: 'https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  { id: 'code-1', category: 'code', body: '```\nconst x = 1\nconst y = 2\n```' },
  { id: 'code-2', category: 'code', body: 'inline `code` in a sentence' },
  { id: 'code-3', category: 'code', body: '```ts\nfunction wide() { return "a very long single code line that may overflow horizontally inside the block" }\n```' },
  { id: 'mixed-1', category: 'mixed', body: '@dave check https://example.com 🎉 it works now after the fix' },
  { id: 'mixed-2', category: 'mixed', body: 'Multi-line with a link https://example.com/docs\nand a second line with @eve and emoji 🚀' },
  { id: 'short-4', category: 'short', body: 'yep' },
  { id: 'short-5', category: 'short', body: 'no problem at all' },
  { id: 'wrap-4', category: 'wrap', body: 'Another medium length message that lands somewhere around two or three lines depending on the column width being tested.' },
  { id: 'wrap-5', category: 'wrap', body: 'Padding message to grow the corpus past the minimum. '.repeat(4).trim() },
  { id: 'mention-3', category: 'mention', body: '@frank the build is green, merging now' },
  { id: 'link-3', category: 'link', body: 'two links https://a.example.com and https://b.example.com in one message' },
] as const
