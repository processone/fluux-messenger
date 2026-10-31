/**
 * The iPhone Duo hinge (FLM-279). The captain's approved answers on FLM-177: Fluux's iOS code
 * reports the hinge to the page as CSS variables, and the layout splits at the hinge. Half open
 * in landscape, the list and the chat sit on either side; half open in portrait, the messages sit
 * above the hinge and the composer and keyboard below it. Flat stays as today.
 *
 * The variables are the ones HingeReporter.swift sets on <html>, with what UIKit reported on the
 * iPhone Duo simulator: an inner screen of 951 x 669 points, and a division band around the fold
 * at 475.5 points with 20-point margins on each side, where buttons keep clear.
 *
 * Run:
 *   npx playwright test --config e2e/playwright.e2e.config.ts --project=hinge-layout-webkit
 */
import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { waitForAnchorSettled } from './harness/scrollHarness'

const DEMO_URL = '/demo.html?tutorial=false'
const HINGE = 475.5
const MARGIN = 20
const LANDSCAPE = { width: 951, height: 669 }
const PORTRAIT = { width: 669, height: 951 }
/** The list's resize handle (Sidebar.tsx). */
const RESIZE_HANDLE = '[role="separator"][aria-orientation="vertical"]'
/** Sub-pixel slack: engines round fractional lengths differently. */
const EPSILON = 0.5

type Line = { x: number } | { y: number } | null

/** What HingeLayout.script(for:) runs: folded with a line and its margin, flat (fully open), or no hinge at all. */
async function setHinge(page: Page, posture: 'folded' | 'flat' | null, line: Line = null) {
  await page.evaluate(({ posture, line, margin }) => {
    const style = document.documentElement.style
    const set = (name: string, value: string | undefined) =>
      value === undefined ? style.removeProperty(name) : style.setProperty(name, value)
    set('--fluux-device-posture', posture ?? undefined)
    set('--fluux-hinge-x', line && 'x' in line ? `${line.x}px` : undefined)
    set('--fluux-hinge-y', line && 'y' in line ? `${line.y}px` : undefined)
    set('--fluux-hinge-margin', line ? `${margin}px` : undefined)
  }, { posture, line, margin: MARGIN })
}

async function openConversation(page: Page, name: string, nav: 'messages' | 'rooms' = 'messages') {
  if (nav === 'rooms') await page.locator('[data-nav="rooms"]').click()
  await page.locator('.sidebar-row').filter({ hasText: name }).first().click()
  await expect(page.locator('[data-conversation-column]')).toBeVisible()
}

/** Every control whose rendered, unclipped box comes within the hinge margin along `axis`. */
async function controlsNearHinge(page: Page, axis: 'x' | 'y') {
  return page.evaluate(({ axis, hinge, margin }) => {
    const selector = 'button, a[href], input, select, textarea, [contenteditable="true"], [role="button"], [role="separator"]'
    return [...document.querySelectorAll<HTMLElement>(selector)].flatMap((el) => {
      const r = el.getBoundingClientRect()
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.closest('[inert]')) return []
      let left = Math.max(0, r.left)
      let top = Math.max(0, r.top)
      let right = Math.min(innerWidth, r.right)
      let bottom = Math.min(innerHeight, r.bottom)
      // Follow containing blocks, not just DOM parents: fixed menus can escape a scroller,
      // and absolute children escape static clips before their positioned containing block.
      let position = getComputedStyle(el).position
      for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        const fixedBlock = style.transform !== 'none' || style.translate !== 'none'
          || style.rotate !== 'none' || style.scale !== 'none' || style.filter !== 'none'
          || style.perspective !== 'none' || style.transformStyle === 'preserve-3d'
          || /\b(layout|paint|strict|content)\b/.test(style.contain)
          || ['backdrop-filter', '-webkit-backdrop-filter'].some(property => {
            const value = style.getPropertyValue(property)
            return value !== '' && value !== 'none'
          })
          || style.willChange.split(',').some(property => {
            const name = property.trim()
            return ['transform', 'translate', 'rotate', 'scale', 'filter', 'perspective', 'backdrop-filter', 'contain'].includes(name)
              || (name === '-webkit-backdrop-filter' && CSS.supports('-webkit-backdrop-filter', 'blur(0px)'))
          })
        if (position === 'fixed' && !fixedBlock) continue
        if (position === 'absolute' && style.position === 'static' && !fixedBlock) continue
        position = style.position
        const clipX = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)
        const clipY = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)
        if (!clipX && !clipY) continue
        const clip = ancestor.getBoundingClientRect()
        const innerLeft = clip.left + ancestor.clientLeft
        const innerTop = clip.top + ancestor.clientTop
        if (clipX) {
          left = Math.max(left, innerLeft)
          right = Math.min(right, innerLeft + ancestor.clientWidth, clip.right - parseFloat(style.borderRightWidth))
        }
        if (clipY) {
          top = Math.max(top, innerTop)
          bottom = Math.min(bottom, innerTop + ancestor.clientHeight, clip.bottom - parseFloat(style.borderBottomWidth))
        }
      }
      if (right <= left || bottom <= top) return []
      const [start, end] = axis === 'x' ? [left, right] : [top, bottom]
      if (end <= hinge - margin || start >= hinge + margin) return []
      return [`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${start.toFixed(1)}-${end.toFixed(1)}`]
    })
  }, { axis, hinge: HINGE, margin: MARGIN })
}

async function probeIsNear(page: Page, axis: 'x' | 'y') {
  return (await controlsNearHinge(page, axis)).some(control => control.includes('Hinge attachment probe'))
}

/** A stable copy of the real demo attachment and its clipping scroller, without virtualizer movement. */
async function hingeControlFixture(page: Page, axis: 'x' | 'y') {
  await bootDemo(page, DEMO_URL)
  await openConversation(page, 'Emma Wilson')
  const attachment = page.locator('.message-row button').filter({ has: page.locator('img') }).first()
  await expect(attachment).toBeVisible()
  await attachment.evaluate((source, { axis, hinge, margin }) => {
    const scroller = source.closest('.overflow-y-auto')!
    const bounds = scroller.getBoundingClientRect()
    const controlBounds = source.getBoundingClientRect()
    const clip = scroller.cloneNode(false) as HTMLElement
    clip.id = 'hinge-control-clip'
    // Use real app markup and measured dimensions, but place its edge outside the band.
    Object.assign(clip.style, {
      position: 'fixed', left: `${bounds.left}px`, top: `${bounds.top}px`,
      width: `${bounds.width}px`, height: `${bounds.height}px`, padding: '0', zIndex: '100',
      [axis === 'x' ? 'width' : 'height']: `${hinge - margin - (axis === 'x' ? bounds.left : bounds.top)}px`,
    })
    const control = source.cloneNode(true) as HTMLElement
    control.setAttribute('aria-label', 'Hinge attachment probe')
    Object.assign(control.style, {
      position: 'absolute', left: '0', top: '0', margin: '0',
      width: `${controlBounds.width}px`, height: `${controlBounds.height}px`,
      [axis === 'x' ? 'left' : 'top']: `${hinge - 2 * margin - (axis === 'x' ? bounds.left : bounds.top)}px`,
    })
    clip.append(control)
    document.body.append(clip)
  }, { axis, hinge: HINGE, margin: MARGIN })
}

test.describe('visible hinge control measurement (FLM-306)', () => {
  test.use({ viewport: PORTRAIT })

  for (const axis of ['x', 'y'] as const) {
    test(`counts only the unclipped portion of a control on ${axis}`, async ({ page }) => {
      // FLM-306: a real attachment's box crossed the hinge, but its scroller ended before it.
      await hingeControlFixture(page, axis)
      expect(await probeIsNear(page, axis)).toBe(false)

      // Expose only part of the control inside the band: clipping must not hide this crossing.
      const clip = page.locator('#hinge-control-clip')
      await clip.evaluate((el, { axis, hinge }) => {
        const bounds = el.getBoundingClientRect()
        el.style[axis === 'x' ? 'width' : 'height'] = `${hinge - (axis === 'x' ? bounds.left : bounds.top)}px`
      }, { axis, hinge: HINGE })
      expect(await probeIsNear(page, axis)).toBe(true)

      // A visible overflow axis must not be clipped just because the other axis clips.
      await clip.evaluate((el, axis) => {
        el.style.overflowX = axis === 'x' ? 'visible' : 'clip'
        el.style.overflowY = axis === 'y' ? 'visible' : 'clip'
        el.style[axis === 'x' ? 'width' : 'height'] = '1px'
      }, axis)
      expect(await probeIsNear(page, axis)).toBe(true)
    })

    test(`reports fixed controls escaping a scroller on ${axis}`, async ({ page }) => {
      // FLM-308 F2: fixed menus can escape overflow ancestors that do not contain them.
      await hingeControlFixture(page, axis)
      const clip = page.locator('#hinge-control-clip')
      const probe = clip.getByRole('button', { name: 'Hinge attachment probe' })
      await probe.evaluate((el, { axis, start }) => {
        Object.assign(el.style, { position: 'fixed', left: '20px', top: '20px' })
        el.style[axis === 'x' ? 'left' : 'top'] = `${start}px`
      }, { axis, start: HINGE - 2 * MARGIN })
      expect(await probeIsNear(page, axis)).toBe(true)

      // These properties re-establish a fixed containing block, so its overflow clips again.
      for (const [property, value] of [
        ['transform', 'translate(0px)'], ['translate', '0px'], ['filter', 'blur(0px)'],
        ['perspective', '1000px'], ['contain', 'layout'], ['contain', 'paint'],
        ['will-change', 'transform'],
        // FLM-308 N2: frosted modal panels and their scrims also contain fixed controls.
        ['backdrop-filter', 'blur(0px)'], ['-webkit-backdrop-filter', 'blur(0px)'],
        ['transform-style', 'preserve-3d'], ['will-change', 'backdrop-filter'],
        ['will-change', '-webkit-backdrop-filter'], ['will-change', 'contain'],
      ] as const) {
        await test.step(`${property}: ${value} contains the fixed control when supported`, async () => {
          const supported = await page.evaluate(({ property, value }) =>
            CSS.supports(property, value) && (property !== 'will-change' || value !== '-webkit-backdrop-filter'
              || CSS.supports('-webkit-backdrop-filter', 'blur(0px)')), { property, value })
          await clip.evaluate((el, { property, value }) => { el.style.setProperty(property, value) }, { property, value })
          if (!supported) {
            // Chromium accepts arbitrary will-change words, but ignores WebKit's blur alias.
            expect(await probeIsNear(page, axis)).toBe(true)
            await clip.evaluate((el, property) => { el.style.removeProperty(property) }, property)
            return
          }
          await probe.evaluate((el, { axis, start }) => {
            const clip = el.parentElement!.getBoundingClientRect()
            el.style[axis === 'x' ? 'left' : 'top'] = `${start - (axis === 'x' ? clip.left : clip.top)}px`
          }, { axis, start: HINGE - 2 * MARGIN })
          const bounds = (await probe.boundingBox())!
          expect(bounds[axis]).toBeCloseTo(HINGE - 2 * MARGIN, 0)
          expect(await probeIsNear(page, axis)).toBe(false)
          await clip.evaluate((el, property) => { el.style.removeProperty(property) }, property)
          await probe.evaluate((el, { axis, start }) => {
            el.style[axis === 'x' ? 'left' : 'top'] = `${start}px`
          }, { axis, start: HINGE - 2 * MARGIN })
          expect(await probeIsNear(page, axis)).toBe(true)
        })
      }

      // A static button inside a fixed menu must escape the same clips as a fixed button.
      await probe.evaluate(el => {
        const bounds = el.getBoundingClientRect()
        const menu = document.createElement('div')
        Object.assign(menu.style, {
          position: 'fixed', left: `${bounds.left}px`, top: `${bounds.top}px`,
          width: `${bounds.width}px`, height: `${bounds.height}px`,
        })
        el.replaceWith(menu)
        menu.append(el)
        el.style.position = 'static'
      })
      expect(await probeIsNear(page, axis)).toBe(true)
    })

    test(`reports absolute controls escaping a static clip on ${axis}`, async ({ page }) => {
      // FLM-308 F2: static overflow ancestors between an absolute child and its block do not clip it.
      await hingeControlFixture(page, axis)
      const clip = page.locator('#hinge-control-clip')
      await clip.evaluate(el => {
        const bounds = el.getBoundingClientRect()
        const block = document.createElement('div')
        Object.assign(block.style, {
          position: 'fixed', left: `${bounds.left}px`, top: `${bounds.top}px`,
          width: `${bounds.width}px`, height: `${bounds.height}px`, zIndex: '100',
        })
        el.replaceWith(block)
        block.append(el)
        Object.assign(el.style, { position: 'static', left: 'auto', top: 'auto' })
      })
      expect(await probeIsNear(page, axis)).toBe(true)
      await clip.evaluate(el => { el.style.position = 'relative' })
      expect(await probeIsNear(page, axis)).toBe(false)
    })

    test(`ignores a transparent ancestor, not a translucent one, on ${axis}`, async ({ page }) => {
      // FLM-306's visible-controls contract also applies to hidden message-toolbar ancestors.
      await hingeControlFixture(page, axis)
      const clip = page.locator('#hinge-control-clip')
      await clip.evaluate(el => { el.style.overflow = 'visible'; el.style.opacity = '0' })
      expect(await probeIsNear(page, axis)).toBe(false)
      await clip.evaluate(el => { el.style.opacity = '0.5' })
      expect(await probeIsNear(page, axis)).toBe(true)
    })
  }
})

test.describe('fixed image menu measurement (FLM-308 F2)', () => {
  test.use({ viewport: PORTRAIT })

  test('reports the real image menu crossing outside the folded scroller', async ({ page }) => {
    await bootDemo(page, DEMO_URL)
    await openConversation(page, 'Emma Wilson')
    await setHinge(page, 'folded', { y: HINGE })
    await expect.poll(async () => {
      const bounds = (await page.locator('[data-conversation-column] > .focus-zone').boundingBox())!
      return bounds.y + bounds.height
    }).toBeCloseTo(HINGE - MARGIN, 0)
    const image = page.locator('.message-row button').filter({ has: page.locator('img') }).first()
    // Folding repositions the anchor; opening before that settles correctly dismisses the menu.
    const anchorId = await image.evaluate(el => el.closest('[data-message-id]')!.getAttribute('data-message-id')!)
    expect(await waitForAnchorSettled(page, anchorId)).not.toBeNull()
    // Open the real menu at controlled coordinates; this tests measurement, not pointer targeting.
    await image.evaluate((el, y) => el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 100, clientY: y, button: 2,
    })), HINGE - 2 * MARGIN)
    const copy = page.getByRole('button', { name: 'Copy image URL', exact: true })
    await expect(copy).toBeVisible()
    const bounds = (await copy.boundingBox())!
    expect(bounds.y).toBeLessThan(HINGE + MARGIN)
    expect(bounds.y + bounds.height).toBeGreaterThan(HINGE - MARGIN)
    expect((await controlsNearHinge(page, 'y')).some(control => control.includes('Copy image URL'))).toBe(true)
    await page.screenshot({ path: test.info().outputPath('fixed-image-menu-crossing.png') })
  })
})

test.describe('half open in landscape', () => {
  test.use({ viewport: LANDSCAPE })

  for (const dir of ['ltr', 'rtl'] as const) {
    test(`the list and the chat meet at the hinge, ${dir}`, async ({ page }) => {
      await bootDemo(page, DEMO_URL)
      await page.evaluate((dir) => { document.documentElement.dir = dir }, dir)
      await openConversation(page, 'Emma Wilson')
      const sidebar = page.getByTestId('sidebar-pane')
      const chat = page.locator('main')
      const flat = (await sidebar.boundingBox())!
      await expect(sidebar.locator(RESIZE_HANDLE)).toHaveCount(1)

      await setHinge(page, 'folded', { x: HINGE })
      const [list, main] = [(await sidebar.boundingBox())!, (await chat.boundingBox())!]
      if (dir === 'ltr') {
        expect(list.x).toBeCloseTo(0, 0)
        expect(Math.abs(list.x + list.width - HINGE)).toBeLessThanOrEqual(EPSILON)
        expect(Math.abs(main.x - HINGE)).toBeLessThanOrEqual(EPSILON)
      } else {
        expect(Math.abs(list.x - HINGE)).toBeLessThanOrEqual(EPSILON)
        expect(Math.abs(main.x + main.width - HINGE)).toBeLessThanOrEqual(EPSILON)
      }
      await expect(sidebar.locator(RESIZE_HANDLE)).toHaveCount(0)
      expect(await controlsNearHinge(page, 'x')).toEqual([])
      await page.screenshot({ path: test.info().outputPath(`landscape-folded-${dir}.png`) })

      // Fully open returns to the list width it had, which stays saved.
      await setHinge(page, 'flat')
      expect((await sidebar.boundingBox())!.width).toBeCloseTo(flat.width, 0)
      await expect(sidebar.locator(RESIZE_HANDLE)).toHaveCount(1)
    })
  }
})

test.describe('half open in portrait', () => {
  test.use({ viewport: PORTRAIT, hasTouch: true, isMobile: true })

  for (const [name, nav, dir] of [
    ['Emma Wilson', 'messages', 'ltr'], ['Team Chat', 'rooms', 'ltr'],
    ['Emma Wilson', 'messages', 'rtl'], ['Team Chat', 'rooms', 'rtl'],
  ] as const) {
    test(`messages above the hinge and the composer below it, ${nav}, ${dir}`, async ({ page }) => {
      await bootDemo(page, DEMO_URL)
      await page.evaluate((dir) => { document.documentElement.dir = dir }, dir)
      await openConversation(page, name, nav)
      const messages = page.locator('[data-conversation-column] > .focus-zone')
      const composer = page.locator('[data-conversation-column] .composer-form')
      const column = page.locator('[data-conversation-column]')
      const flatComposer = (await composer.boundingBox())!
      const flatColumn = (await column.boundingBox())!
      expect(flatComposer.y + flatComposer.height).toBeCloseTo(flatColumn.y + flatColumn.height, 0)

      await setHinge(page, 'folded', { y: HINGE })
      await expect.poll(async () => { const box = (await messages.boundingBox())!; return box.y + box.height })
        .toBeCloseTo(HINGE - MARGIN, 0)
      const below = (await composer.boundingBox())!
      expect(Math.abs(below.y - (HINGE + MARGIN))).toBeLessThanOrEqual(EPSILON)
      expect(await controlsNearHinge(page, 'y')).toEqual([])
      await page.screenshot({ path: test.info().outputPath(`portrait-folded-${nav}-${dir}.png`) })

      // The keyboard fills the band and the half below it, so iOS ends the page above the band
      // and the composer sits on the keyboard.
      await page.setViewportSize({ width: PORTRAIT.width, height: 455 })
      await expect.poll(async () => { const box = (await composer.boundingBox())!; return box.y + box.height }).toBeCloseTo(455, 0)

      // Fully open returns to today's layout.
      await page.setViewportSize(PORTRAIT)
      await setHinge(page, 'flat')
      await expect.poll(async () => { const box = (await composer.boundingBox())!; return box.y + box.height })
        .toBeCloseTo(flatColumn.y + flatColumn.height, 0)
    })
  }
})
