/**
 * Lazy-loaded Shiki syntax highlighter singleton.
 *
 * All Shiki imports use dynamic import() so Vite code-splits Shiki
 * (core + WASM + grammars) into its own chunk, loaded only when
 * a code block with a language hint is first encountered.
 */
import { useState, useEffect } from 'react'

type Highlighter = Awaited<ReturnType<typeof import('shiki')['createHighlighter']>>

let highlighterPromise: Promise<Highlighter> | null = null
let highlighterInstance: Highlighter | null = null

const COMMON_LANGS = [
  'javascript', 'typescript', 'python', 'html', 'css', 'json',
  'bash', 'shell', 'xml', 'rust', 'go', 'java', 'c', 'cpp',
  'sql', 'yaml', 'toml', 'markdown', 'swift', 'kotlin', 'lua',
  'ruby', 'php', 'elixir', 'erlang', 'zig', 'haskell', 'jsx', 'tsx',
] as const

/**
 * Lazily initialize the Shiki highlighter. Returns a cached promise
 * on subsequent calls. Only triggers the dynamic import when first called.
 */
/** Custom theme name registered with the highlighter */
const THEME_NAME = 'fluux-css-vars'

export function ensureHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(async ({ createHighlighter, createCssVariablesTheme }) => {
      const cssVarsTheme = createCssVariablesTheme({
        name: THEME_NAME,
        variablePrefix: '--shiki-',
        variableDefaults: {},
        fontStyle: true,
      })
      const instance = await createHighlighter({
        themes: [cssVarsTheme],
        langs: [...COMMON_LANGS],
      })
      highlighterInstance = instance
      return instance
    })
  }
  return highlighterPromise
}

/**
 * Synchronously highlight code if the highlighter is ready.
 * Returns an HTML string with `<span style="color: var(--shiki-*)">` tokens,
 * or null if the highlighter hasn't loaded yet.
 *
 * Shiki escapes all input before wrapping in <span> tags — output is safe
 * for use with dangerouslySetInnerHTML.
 */
export function highlightCode(code: string, lang: string): string | null {
  if (!highlighterInstance) return null

  const loadedLangs = highlighterInstance.getLoadedLanguages()
  if (!loadedLangs.includes(lang as never)) {
    return null
  }

  const html = highlighterInstance.codeToHtml(code, {
    lang,
    theme: THEME_NAME,
  })

  // Shiki wraps output in <pre><code>...</code></pre>.
  // We manage our own <pre>/<code> wrapper, so strip the outer tags.
  const match = html.match(/<pre[^>]*><code[^>]*>([\s\S]*)<\/code><\/pre>/)
  return match ? match[1] : html
}

/**
 * React hook that lazily loads the Shiki highlighter and provides
 * a highlight function. Only triggers loading when a language is specified.
 */
export function useHighlighter(language?: string): {
  ready: boolean
  highlight: (code: string, lang: string) => string | null
} {
  const [ready, setReady] = useState(highlighterInstance !== null)

  useEffect(() => {
    if (!language || ready) return

    let cancelled = false
    ensureHighlighter().then(() => {
      if (!cancelled) setReady(true)
    })
    return () => { cancelled = true }
  }, [language, ready])

  return { ready, highlight: highlightCode }
}
