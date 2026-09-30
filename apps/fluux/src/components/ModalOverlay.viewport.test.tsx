// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { ModalOverlay } from './ModalOverlay'

let restorePlatform: () => void
beforeEach(() => { restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' }) })
afterEach(() => { cleanup(); restorePlatform(); vi.unstubAllGlobals() })

function setViewport(width: number, height: number, screenHeight = height) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  vi.stubGlobal('screen', { width, height: screenHeight })
  const viewport = Object.assign(new EventTarget(), { height, width, offsetTop: 0, offsetLeft: 0, scale: 1 })
  vi.stubGlobal('visualViewport', viewport)
  return viewport
}

it.each([
  { shell: 'mobile', os: 'ios' },
  { shell: 'desktop', os: 'windows' },
  { shell: 'desktop', os: 'macos' },
  { shell: 'desktop', os: 'linux' },
  { shell: 'web', os: 'android' },
] as const)('preserves visual viewport keyboard handling on $shell/$os', host => {
  setPlatformForTesting(host)
  const viewport = setViewport(390, 844, 1080)
  const { container, unmount } = render(<ModalOverlay onClose={() => {}} panelProps={{ style: { maxHeight: '240px' } }}><input /></ModalOverlay>)
  const root = container.querySelector<HTMLElement>('[data-modal]')!
  const panel = container.querySelector<HTMLElement>('.fluux-glass')!
  expect(root.dataset.keyboard).toBeUndefined()
  expect(root.style.height).toBe('')
  expect(panel.style.maxHeight).toBe('240px')
  viewport.height = 300
  viewport.offsetTop = 40
  viewport.dispatchEvent(new Event('resize'))
  expect(root.style.top).toBe('40px')
  expect(root.style.height).toBe('300px')
  expect(root.dataset.keyboard).toBe('true')
  expect(panel.style.maxHeight).toBe('240px')
  viewport.height = 200
  viewport.dispatchEvent(new Event('resize'))
  expect(panel.style.maxHeight).toBe('168px')
  viewport.offsetTop = 60
  viewport.dispatchEvent(new Event('scroll'))
  expect(root.style.top).toBe('60px')
  viewport.height = window.innerHeight
  viewport.offsetTop = 0
  viewport.dispatchEvent(new Event('resize'))
  expect(root.style.height).toBe('')
  expect(root.dataset.keyboard).toBeUndefined()
  expect(panel.style.maxHeight).toBe('240px')
  unmount()
  viewport.height = 200
  viewport.dispatchEvent(new Event('resize'))
  expect(root.style.height).toBe('')
})

it.each([
  { orientation: 'portrait', width: 390, height: 844, visibleHeight: 480 },
  { orientation: 'landscape', width: 844, height: 390, visibleHeight: 160 },
])('handles Android keyboard open and close in $orientation', ({ width, height, visibleHeight }) => {
  setPlatformForTesting({ shell: 'mobile', os: 'android' })
  const viewport = setViewport(width, height)
  const { container, unmount } = render(<ModalOverlay onClose={() => {}} panelProps={{ style: { maxHeight: `${height}px` } }}><input /></ModalOverlay>)
  const root = container.querySelector<HTMLElement>('[data-modal]')!
  const panel = container.querySelector<HTMLElement>('.fluux-glass')!
  expect(root.dataset.keyboard).toBeUndefined()
  expect(panel.style.maxHeight).toBe(`${height}px`)

  vi.stubGlobal('innerHeight', visibleHeight)
  viewport.height = visibleHeight
  viewport.dispatchEvent(new Event('resize'))
  expect(root.dataset.keyboard).toBe('true')
  expect(root.style.height).toBe(`${visibleHeight}px`)
  expect(root.style.width).toBe(`${width}px`)
  expect(panel.style.maxHeight).toBe(`${visibleHeight - 32}px`)

  vi.stubGlobal('innerHeight', height)
  viewport.height = height
  window.dispatchEvent(new Event('resize'))
  expect(root.dataset.keyboard).toBeUndefined()
  expect(root.style.height).toBe('')
  expect(panel.style.maxHeight).toBe(`${height}px`)

  vi.stubGlobal('innerHeight', visibleHeight)
  viewport.height = visibleHeight
  window.dispatchEvent(new Event('resize'))
  expect(root.dataset.keyboard).toBe('true')
  unmount()
  expect(root.dataset.keyboard).toBeUndefined()
  expect(root.style.height).toBe('')
  expect(panel.style.maxHeight).toBe(`${height}px`)
  viewport.dispatchEvent(new Event('resize'))
  expect(root.dataset.keyboard).toBeUndefined()
})

it.each([
  { label: 'open in portrait', width: 390, height: 480, screenHeight: 844, scale: 1, keyboard: true },
  { label: 'open in landscape', width: 844, height: 160, screenHeight: 390, scale: 1, keyboard: true },
  { label: 'rounded portrait viewport', width: 390, height: 843, screenHeight: 844, scale: 1, keyboard: false },
  { label: 'rounded landscape viewport', width: 844, height: 389, screenHeight: 390, scale: 1, keyboard: false },
  { label: 'pinch zoom', width: 390, height: 480, screenHeight: 844, scale: 2, keyboard: false },
])('initializes Android dialogs with $label', ({ width, height, screenHeight, scale, keyboard }) => {
  setPlatformForTesting({ shell: 'mobile', os: 'android' })
  const viewport = setViewport(width, height, screenHeight)
  viewport.scale = scale
  const { container } = render(<ModalOverlay onClose={() => {}}><input /></ModalOverlay>)
  const root = container.querySelector<HTMLElement>('[data-modal]')!
  const panel = container.querySelector<HTMLElement>('.fluux-glass')!
  expect(root.dataset.keyboard).toBe(keyboard ? 'true' : undefined)
  expect(panel.style.maxHeight).toBe(keyboard ? `${height - 32}px` : '')
})
