import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const locales = fileURLToPath(new URL('../src/i18n/locales', import.meta.url))
const ios = fileURLToPath(new URL('../src-tauri/mobile/ios/Resources', import.meta.url))
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;').replaceAll("'", "\\'")
export function shareResources(androidMain) {
  for (const filename of readdirSync(locales).filter(name => name.endsWith('.json'))) {
    const locale = filename.slice(0, -5)
    const { sharing, common } = JSON.parse(readFileSync(join(locales, filename), 'utf8'))
    if (androidMain) {
      const tag = locale === 'en' ? '' : `-${locale === 'zh-CN' ? 'zh-rCN' : locale === 'he' ? 'iw' : locale}`
      const dir = join(androidMain, 'res', `values${tag}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'fluux_share.xml'), `<resources><string name="share_import_error">${xml(sharing.importError)}</string></resources>\n`)
    } else {
      const dir = join(ios, `${locale === 'zh-CN' ? 'zh-Hans' : locale}.lproj`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'Localizable.strings'), Object.entries({ share_saved: sharing.saved, share_import_error: sharing.importError, share_close: common.close })
        .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)};`).join('\n') + '\n')
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) shareResources()
