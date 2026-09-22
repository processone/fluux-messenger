import type { Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

let bundle: Promise<string> | undefined

export async function installViewportGeometryFixture(page: Page): Promise<void> {
  bundle ??= build({
    stdin: {
      contents: `
        export { ViewportSession } from './apps/fluux/src/components/conversation/viewportSession.ts'
        export function readViewportGeometry(scroller) {
          const geometry = {
            top: scroller.scrollTop,
            height: scroller.scrollHeight,
            client: scroller.clientHeight,
          }
          const row = scroller.querySelector('[data-message-row-id], [data-message-id]')
          if (!row) return geometry
          const rowId = row.dataset.messageRowId || row.dataset.messageId
          const scrollerTop = scroller.getBoundingClientRect().top + scroller.clientTop
          const rowTop = row.getBoundingClientRect().top - scrollerTop + geometry.top
          geometry.anchor = { rowId, top: rowTop }
          geometry.visibleAnchor = { rowId, top: rowTop }
          return geometry
        }
      `,
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__scrollGeometryFixture',
  }).then(result => result.outputFiles[0].text)
  await page.addScriptTag({ content: await bundle })
}
