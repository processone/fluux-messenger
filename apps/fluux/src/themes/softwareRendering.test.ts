// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { classifyRenderer, detectSoftwareRendering, readRendererString, resetSoftwareRenderingProbe } from './softwareRendering'

describe('classifyRenderer', () => {
  it('identifies Chromium/WebView2 software GL (SwiftShader)', () => {
    expect(
      classifyRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'),
    ).toBe('software')
  })

  it('identifies the Microsoft Basic Render Driver', () => {
    expect(
      classifyRenderer('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    ).toBe('software')
  })

  it('identifies Mesa software rasterisers', () => {
    expect(classifyRenderer('llvmpipe (LLVM 15.0.6, 256 bits)')).toBe('software')
    expect(classifyRenderer('softpipe')).toBe('software')
    expect(classifyRenderer('lavapipe (LLVM 15.0.6)')).toBe('software')
    expect(classifyRenderer('Mesa swrast')).toBe('software')
  })

  it('identifies Direct3D WARP', () => {
    expect(classifyRenderer('Microsoft Direct3D WARP device')).toBe('software')
  })

  it('is case-insensitive', () => {
    expect(classifyRenderer('LLVMPIPE (LLVM 15.0.6)')).toBe('software')
  })

  it('treats a real GPU as hardware', () => {
    expect(classifyRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)')).toBe('hardware')
    expect(
      classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    ).toBe('hardware')
    expect(classifyRenderer('Mesa Intel(R) UHD Graphics 620 (KBL GT2)')).toBe('hardware')
  })

  it('treats an absent or empty string as unknown, never as software', () => {
    expect(classifyRenderer(null)).toBe('unknown')
    expect(classifyRenderer(undefined)).toBe('unknown')
    expect(classifyRenderer('')).toBe('unknown')
  })

  it('does not match "warp" inside an unrelated word', () => {
    expect(classifyRenderer('Warpdrive Graphics Accelerator 9000')).toBe('hardware')
  })
})

// --- probe ---------------------------------------------------------------
// jsdom has no WebGL; these tests stub the canvas context entirely.

const UNMASKED_RENDERER = 0x9246

function stubWebGL(renderer: unknown, opts: { extension?: boolean } = {}) {
  const lose = { loseContext: vi.fn() }
  const gl = {
    getExtension: vi.fn((name: string) => {
      if (name === 'WEBGL_lose_context') return lose
      if (name === 'WEBGL_debug_renderer_info') {
        return opts.extension === false ? null : { UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER }
      }
      return null
    }),
    getParameter: vi.fn((p: number) => (p === UNMASKED_RENDERER ? renderer : null)),
  }
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(gl as unknown as RenderingContext)
  return { gl, lose, spy }
}

describe('readRendererString', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetSoftwareRenderingProbe()
  })

  it('returns the unmasked renderer string', () => {
    stubWebGL('llvmpipe (LLVM 15.0.6, 256 bits)')
    expect(readRendererString()).toBe('llvmpipe (LLVM 15.0.6, 256 bits)')
  })

  it('returns null when the debug-renderer extension is unavailable', () => {
    stubWebGL('llvmpipe', { extension: false })
    expect(readRendererString()).toBeNull()
  })

  it('returns null when the driver reports a non-string renderer', () => {
    stubWebGL(42)
    expect(readRendererString()).toBeNull()
  })

  it('returns null when no WebGL context can be created', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(readRendererString()).toBeNull()
  })

  it('releases the throwaway context instead of leaking it', () => {
    const { lose } = stubWebGL('llvmpipe')
    readRendererString()
    expect(lose.loseContext).toHaveBeenCalledTimes(1)
  })

  it('survives a throwing getContext', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('context creation blocked')
    })
    expect(readRendererString()).toBeNull()
  })
})

describe('detectSoftwareRendering', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetSoftwareRenderingProbe()
  })

  it('is true for a software rasteriser', () => {
    stubWebGL('llvmpipe (LLVM 15.0.6, 256 bits)')
    expect(detectSoftwareRendering()).toBe(true)
  })

  it('is false for a real GPU', () => {
    stubWebGL('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)')
    expect(detectSoftwareRendering()).toBe(false)
  })

  it('is false when the renderer cannot be determined', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(detectSoftwareRendering()).toBe(false)
  })

  it('probes the GPU only once per session', () => {
    const { spy } = stubWebGL('llvmpipe')
    detectSoftwareRendering()
    detectSoftwareRendering()
    detectSoftwareRendering()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
