import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DESKTOP_BREAKPOINT = 768

type TauriConfig = {
  app: {
    windows: Array<{
      minWidth: number
    }>
  }
}

const tauriConfigPath = resolve(process.cwd(), 'src-tauri/tauri.conf.json')

describe('desktop responsive window contract', () => {
  it('allows the shared native window to cross the 768px layout breakpoint', () => {
    const config = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as TauriConfig
    const minWidth = config.app.windows[0]?.minWidth

    expect(minWidth).toBeLessThan(DESKTOP_BREAKPOINT)
  })
})
