import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MESSAGE_BUBBLE_PATH, GLYPH_TRANSFORM } from './messageBubbleGlyph'

// process.cwd() is apps/fluux when vitest runs in this workspace.
const HOLLOW = resolve(process.cwd(), 'src-tauri/icons/icon-variants/hollow')

describe('hollow icon sources embed the shared glyph constants', () => {
  for (const file of ['icon-source.svg', 'icon-source-maskable.svg']) {
    it(`${file} uses the pinned path and transform`, () => {
      const svg = readFileSync(resolve(HOLLOW, file), 'utf8')
      expect(svg).toContain(MESSAGE_BUBBLE_PATH)
      expect(svg).toContain(GLYPH_TRANSFORM)
      // shadow must live on an unscaled wrapper, not the scaled glyph group
      expect(svg).toMatch(/stdDeviation="14\.4"/)
    })
  }
})
