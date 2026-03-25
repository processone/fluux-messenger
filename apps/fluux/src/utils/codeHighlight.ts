/**
 * Lazy-loaded Shiki syntax highlighter with per-language lazy loading.
 *
 * The Shiki core + WASM engine is code-split via dynamic import and loaded
 * only when a code block is first encountered. Individual language grammars
 * are then loaded on demand — only the languages actually used get fetched.
 */
import { useState, useEffect } from 'react'

type HighlighterCore = Awaited<ReturnType<typeof import('shiki/core')['createHighlighterCore']>>

let highlighterPromise: Promise<HighlighterCore> | null = null
let highlighterInstance: HighlighterCore | null = null

/** Tracks in-flight language loads to avoid duplicate imports */
const langLoadPromises = new Map<string, Promise<void>>()

/**
 * Static import map for language grammars.
 * Each entry is a lazy loader — Vite can statically analyze these literal
 * import paths, enabling proper code-splitting per language.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LANG_IMPORTS: Record<string, () => Promise<any>> = {
  javascript:  () => import('shiki/langs/javascript.mjs'),
  typescript:  () => import('shiki/langs/typescript.mjs'),
  python:      () => import('shiki/langs/python.mjs'),
  html:        () => import('shiki/langs/html.mjs'),
  css:         () => import('shiki/langs/css.mjs'),
  json:        () => import('shiki/langs/json.mjs'),
  bash:        () => import('shiki/langs/bash.mjs'),
  shell:       () => import('shiki/langs/shell.mjs'),
  xml:         () => import('shiki/langs/xml.mjs'),
  rust:        () => import('shiki/langs/rust.mjs'),
  go:          () => import('shiki/langs/go.mjs'),
  java:        () => import('shiki/langs/java.mjs'),
  c:           () => import('shiki/langs/c.mjs'),
  cpp:         () => import('shiki/langs/cpp.mjs'),
  sql:         () => import('shiki/langs/sql.mjs'),
  yaml:        () => import('shiki/langs/yaml.mjs'),
  toml:        () => import('shiki/langs/toml.mjs'),
  markdown:    () => import('shiki/langs/markdown.mjs'),
  swift:       () => import('shiki/langs/swift.mjs'),
  kotlin:      () => import('shiki/langs/kotlin.mjs'),
  lua:         () => import('shiki/langs/lua.mjs'),
  ruby:        () => import('shiki/langs/ruby.mjs'),
  php:         () => import('shiki/langs/php.mjs'),
  elixir:      () => import('shiki/langs/elixir.mjs'),
  erlang:      () => import('shiki/langs/erlang.mjs'),
  zig:         () => import('shiki/langs/zig.mjs'),
  haskell:     () => import('shiki/langs/haskell.mjs'),
  jsx:         () => import('shiki/langs/jsx.mjs'),
  tsx:         () => import('shiki/langs/tsx.mjs'),
}

const THEME_NAME = 'fluux-css-vars'

/**
 * Lazily initialize the Shiki highlighter core with no languages.
 * Languages are loaded individually via ensureLanguage().
 */
function ensureHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki/core').then(async ({ createHighlighterCore, createCssVariablesTheme }) => {
      const cssVarsTheme = createCssVariablesTheme({
        name: THEME_NAME,
        variablePrefix: '--syntax-',
        variableDefaults: {},
        fontStyle: true,
      })
      const instance = await createHighlighterCore({
        themes: [cssVarsTheme],
        langs: [],
        engine: import('shiki/engine/oniguruma').then(m => m.createOnigurumaEngine(import('shiki/wasm'))),
      })
      highlighterInstance = instance
      return instance
    })
  }
  return highlighterPromise
}

/**
 * Ensure a specific language grammar is loaded. Returns immediately
 * if already loaded; deduplicates concurrent requests for the same language.
 */
async function ensureLanguage(lang: string): Promise<void> {
  const loader = LANG_IMPORTS[lang]
  if (!loader) return

  const hl = await ensureHighlighter()
  if (hl.getLoadedLanguages().includes(lang as never)) return

  if (!langLoadPromises.has(lang)) {
    const promise = loader()
      .then(mod => hl.loadLanguage(mod.default ?? mod))
      .finally(() => langLoadPromises.delete(lang))
    langLoadPromises.set(lang, promise)
  }
  await langLoadPromises.get(lang)
}

/**
 * Synchronously highlight code if the highlighter is ready.
 * Returns an HTML string with `<span style="color: var(--syntax-*)">` tokens,
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
  const [ready, setReady] = useState(() =>
    highlighterInstance !== null &&
    (!language || highlighterInstance.getLoadedLanguages().includes(language as never))
  )

  useEffect(() => {
    if (!language || ready) return

    let cancelled = false
    void ensureLanguage(language).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => { cancelled = true }
  }, [language, ready])

  return { ready, highlight: highlightCode }
}
