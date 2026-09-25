// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ModalOverlay } from './ModalOverlay'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('fits the keyboard viewport, preserves smaller caller limits and restores sizing on close', () => {
  const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 })
  vi.stubGlobal('visualViewport', viewport)
  const { container, unmount } = render(<ModalOverlay onClose={() => {}} panelProps={{ style: { maxHeight: '240px' } }}><input /></ModalOverlay>)
  const root = container.querySelector<HTMLElement>('[data-modal]')!
  const panel = container.querySelector<HTMLElement>('.fluux-glass')!
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
