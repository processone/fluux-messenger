import { describe, it, expect } from 'vitest'
import { classifyRenderer } from './softwareRendering'

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
