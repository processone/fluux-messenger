import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const locales = fileURLToPath(new URL('../src/i18n/locales', import.meta.url))
const ios = fileURLToPath(new URL('../src-tauri/mobile/ios/Resources', import.meta.url))
const iosApp = fileURLToPath(new URL('../src-tauri/mobile/ios/AppResources', import.meta.url))
const strings = entries => Object.entries(entries).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)};`).join('\n') + '\n'
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;').replaceAll("'", "\\'")
export function shareResources(androidMain) {
  for (const filename of readdirSync(locales).filter(name => name.endsWith('.json'))) {
    const locale = filename.slice(0, -5)
    const { sharing, common, upload, notificationPreview } = JSON.parse(readFileSync(join(locales, filename), 'utf8'))
    if (androidMain) {
      const tag = locale === 'en' ? '' : `-${locale === 'zh-CN' ? 'zh-rCN' : locale === 'he' ? 'iw' : locale}`
      const dir = join(androidMain, 'res', `values${tag}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'fluux_share.xml'), `<resources><string name="share_import_error">${xml(sharing.importError)}</string></resources>\n`)
    } else {
      const lproj = `${locale === 'zh-CN' ? 'zh-Hans' : locale}.lproj`
      const dir = join(ios, lproj)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'Localizable.strings'), strings({ share_saved: sharing.saved, share_import_error: sharing.importError, share_close: common.close }))
      // Permission prompts of the app itself, shown by the file picker's camera option.
      const appDir = join(iosApp, lproj)
      mkdirSync(appDir, { recursive: true })
      writeFileSync(join(appDir, 'NotificationPreviews.strings'), strings(notificationPreview))
      writeFileSync(join(appDir, 'InfoPlist.strings'), strings({ NSCameraUsageDescription: upload.cameraUsage, NSMicrophoneUsageDescription: upload.microphoneUsage }))
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) shareResources()
