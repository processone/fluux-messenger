/**
 * The self-hosted UI and display faces must cover the letters the app's own
 * translations use, script by script.
 *
 * A face that covers part of a script is the dangerous case: the browser falls
 * back one character at a time, so a Polish heading drew `ł`/`ą` in Inter and
 * the rest of the word in Inter Tight (whose files stopped at Latin-1). A face
 * that covers none of a script falls back whole, which reads fine on its own;
 * but the display face must still cover every script the UI face covers, or
 * Cyrillic and Greek headings lose the heading style entirely.
 *
 * The Inter and Inter Display files must also carry the serif I and tailed l
 * baked in by scripts/fonts/bake-inter.py; a file copied straight from an Inter
 * release lacks the version-string mark that script writes.
 *
 * The checks read the woff2 tables directly, so they follow whatever files
 * `index.css` points at.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const appRoot = process.cwd()
const css = readFileSync(resolve(appRoot, 'src/index.css'), 'utf8')

// ── woff2 → set of code points ─────────────────────────────────────────────

function readBase128(buf: Buffer, pos: number): [number, number] {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos++]
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return [value, pos]
  }
  throw new Error('bad UIntBase128')
}

const GLYF = 10
const LOCA = 11
const ARBITRARY_TAG = 63

const CMAP = 0
const NAME = 5

/** A woff2 file's decompressed tables, by known-tag index (`cmap` is 0, `name` is 5). */
function woff2Tables(path: string): Map<number, Buffer> {
  const file = readFileSync(path)
  if (file.toString('latin1', 0, 4) !== 'wOF2') throw new Error(`${path} is not woff2`)
  const numTables = file.readUInt16BE(12)
  let pos = 48
  let offset = 0
  const spans = new Map<number, { offset: number; length: number }>()
  for (let t = 0; t < numTables; t++) {
    const flags = file[pos++]
    const tagIndex = flags & 0x3f
    const transform = flags >> 6
    if (tagIndex === ARBITRARY_TAG) pos += 4
    let origLength: number
    ;[origLength, pos] = readBase128(file, pos)
    let length = origLength
    const isGlyfOrLoca = tagIndex === GLYF || tagIndex === LOCA
    if ((isGlyfOrLoca && transform === 0) || (!isGlyfOrLoca && transform !== 0)) {
      ;[length, pos] = readBase128(file, pos)
    }
    if (tagIndex !== ARBITRARY_TAG) spans.set(tagIndex, { offset, length })
    offset += length
  }
  const data = brotliDecompressSync(file.subarray(pos, pos + file.readUInt32BE(20)))
  const tables = new Map<number, Buffer>()
  for (const [tag, span] of spans) tables.set(tag, data.subarray(span.offset, span.offset + span.length))
  return tables
}

/** The Windows-platform (UTF-16BE) strings of a woff2 file's `name` table for one name id. */
function woff2Names(path: string, nameId: number): string[] {
  const table = woff2Tables(path).get(NAME)
  if (!table) throw new Error(`${path} has no name table`)
  const count = table.readUInt16BE(2)
  const strings = table.readUInt16BE(4)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12
    if (table.readUInt16BE(rec) !== 3 || table.readUInt16BE(rec + 6) !== nameId) continue
    const start = strings + table.readUInt16BE(rec + 10)
    out.push(Buffer.from(table.subarray(start, start + table.readUInt16BE(rec + 8))).swap16().toString('utf16le'))
  }
  return out
}

/** Code points mapped by a woff2 file's `cmap` (format 4 or 12 subtable). */
function woff2CodePoints(path: string): Set<number> {
  const table = woff2Tables(path).get(CMAP)
  if (!table) throw new Error(`${path} has no cmap`)

  const points = new Set<number>()
  const numSubtables = table.readUInt16BE(2)
  for (let i = 0; i < numSubtables; i++) {
    const sub = table.readUInt32BE(4 + i * 8 + 4)
    const format = table.readUInt16BE(sub)
    if (format === 12) {
      const groups = table.readUInt32BE(sub + 12)
      for (let g = 0; g < groups; g++) {
        const start = table.readUInt32BE(sub + 16 + g * 12)
        const end = table.readUInt32BE(sub + 20 + g * 12)
        for (let c = start; c <= end; c++) points.add(c)
      }
    } else if (format === 4) {
      const segCount = table.readUInt16BE(sub + 6) / 2
      const ends = sub + 14
      const starts = ends + segCount * 2 + 2
      for (let s = 0; s < segCount; s++) {
        const end = table.readUInt16BE(ends + s * 2)
        const start = table.readUInt16BE(starts + s * 2)
        // 0xFFFF terminates the segment list; it is not a real glyph.
        for (let c = start; c <= end && c !== 0xffff; c++) points.add(c)
      }
    }
  }
  return points
}

// ── which files back the UI and display families ───────────────────────────

function familiesOf(token: string): string[] {
  const match = css.match(new RegExp(`${token}:\\s*([^;]+);`))
  if (!match) throw new Error(`${token} not found in index.css`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function filesOf(family: string): string[] {
  const files: string[] = []
  for (const block of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const fam = block[1].match(/font-family:\s*'([^']+)'/)?.[1]
    const url = block[1].match(/url\('\/fonts\/([^']+)'\)/)?.[1]
    if (fam === family && url) files.push(url)
  }
  return files
}

const uiFiles = familiesOf('--fluux-font-ui').flatMap(filesOf)
const displayFiles = familiesOf('--fluux-font-display').flatMap(filesOf)

// ── letters the translations use, by script ────────────────────────────────

const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Hebrew', 'Arabic', 'Han', 'Hangul'] as const
type Script = (typeof SCRIPTS)[number]
const scriptRe = Object.fromEntries(
  SCRIPTS.map((s) => [s, new RegExp(`^\\p{Script=${s}}$`, 'u')]),
) as Record<Script, RegExp>

const localeModules = import.meta.glob('./i18n/locales/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const lettersByScript = new Map<Script, Set<number>>()
for (const raw of Object.values(localeModules)) {
  for (const ch of raw.normalize('NFC')) {
    if (!/\p{L}/u.test(ch)) continue
    const script = SCRIPTS.find((s) => scriptRe[s].test(ch))
    if (!script) continue
    if (!lettersByScript.has(script)) lettersByScript.set(script, new Set())
    lettersByScript.get(script)!.add(ch.codePointAt(0)!)
  }
}

function coveredScripts(points: Set<number>): Script[] {
  return [...lettersByScript.entries()]
    .filter(([, letters]) => [...letters].some((c) => points.has(c)))
    .map(([s]) => s)
}

describe('self-hosted font coverage', () => {
  it('finds the faces and the locale letters it checks', () => {
    expect(uiFiles.length).toBeGreaterThan(0)
    expect(displayFiles.length).toBeGreaterThan(0)
    expect(lettersByScript.get('Latin')?.size).toBeGreaterThan(100)
    expect(lettersByScript.get('Cyrillic')?.size).toBeGreaterThan(30)
  })

  it.each([...new Set([...uiFiles, ...displayFiles])])('%s covers every translated letter of each script it touches', (file) => {
    const points = woff2CodePoints(resolve(appRoot, 'public/fonts', file))
    const missing: string[] = []
    for (const script of coveredScripts(points)) {
      for (const c of lettersByScript.get(script)!) {
        if (!points.has(c)) missing.push(`${script} ${String.fromCodePoint(c)}`)
      }
    }
    expect(missing).toEqual([])
  })

  it.each(displayFiles)('%s covers every script the UI face covers', (file) => {
    const display = coveredScripts(woff2CodePoints(resolve(appRoot, 'public/fonts', file)))
    const ui = coveredScripts(woff2CodePoints(resolve(appRoot, 'public/fonts', uiFiles[0])))
    expect(display).toEqual(expect.arrayContaining(ui))
  })

  it.each([...new Set([...uiFiles, ...displayFiles])].filter((f) => f.startsWith('Inter')))(
    '%s has the I/l alternates baked in',
    (file) => {
      const versions = woff2Names(resolve(appRoot, 'public/fonts', file), 5)
      expect(versions.length).toBeGreaterThan(0)
      for (const version of versions) expect(version).toContain('fluux-baked cv05 cv08')
    },
  )
})
