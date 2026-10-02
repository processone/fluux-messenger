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

type JsonObject = { [key: string]: unknown }

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON Merge Patch (RFC 7396), which Tauri uses to lay a platform config over the base one. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch
  const merged: JsonObject = isObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = mergePatch(merged[key], value)
  }
  return merged
}

function readConfig(name: string): JsonObject {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'src-tauri', name), 'utf8')) as JsonObject
}

describe('Windows window configuration', () => {
  const base = readConfig('tauri.conf.json') as unknown as { app: { windows: JsonObject[] } }
  const effective = mergePatch(base, readConfig('tauri.windows.conf.json')) as { app: { windows: JsonObject[] } }

  // A merge patch replaces an array wholesale, so the Windows file has to
  // restate the whole window entry: anything it leaves out falls back to
  // Tauri's default instead of to the base value.
  it('is the shared window entry with the native frame removed, and nothing else changed', () => {
    expect(base.app.windows).toHaveLength(1)
    expect(effective.app.windows).toEqual([{ ...base.app.windows[0], decorations: false }])
  })

  it('keeps the native frame in the shared entry the other desktop platforms use', () => {
    expect(base.app.windows[0]).not.toHaveProperty('decorations')
  })

  it('still lets the frameless window cross the 768px layout breakpoint', () => {
    expect(effective.app.windows[0]?.minWidth).toBeLessThan(DESKTOP_BREAKPOINT)
  })

  // The default shadow is what gives an undecorated window its rounded corners
  // and border on Windows 11.
  it('keeps the default window shadow', () => {
    expect(effective.app.windows[0]).not.toHaveProperty('shadow')
  })
})
