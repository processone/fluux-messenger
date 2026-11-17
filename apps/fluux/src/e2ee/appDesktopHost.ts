/**
 * App adapter for the desktop plugin's host facts: the native key-file dialogs
 * ({@link OpenPGPFileIO}) and whether this is the macOS desktop app. Built by
 * `registerPlugins` (and the demo fixtures) and spread into the plugin's
 * options; the plugin itself imports no Tauri dialog, filesystem or platform
 * module. The Tauri plugins load on first use, as before.
 */

import type { OpenPGPFileIO } from '@fluux/openpgp-plugin'
import { platform } from '@/platform'

const KEY_FILE_FILTERS = [{ name: 'OpenPGP Armor', extensions: ['asc', 'pgp', 'gpg'] }]

export function createAppFileIO(): OpenPGPFileIO {
  return {
    async saveFile(defaultName, armored) {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const filePath = await save({ defaultPath: defaultName, filters: KEY_FILE_FILTERS })
      if (!filePath) return false
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      await writeTextFile(filePath, armored)
      return true
    },
    async pickFile() {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const result = await open({ multiple: false, filters: KEY_FILE_FILTERS })
      if (!result) return null
      const filePath = typeof result === 'string' ? result : result[0]
      if (!filePath) return null
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      return readTextFile(filePath)
    },
  }
}

/** True on the macOS desktop app; false on other desktops, iOS and the web. */
export function isMacosDesktop(): boolean {
  const { shell, os } = platform()
  return shell === 'desktop' && os === 'macos'
}

/** The plugin options the host supplies: file dialogs and the macOS-desktop fact. */
export function createAppDesktopHost(): { fileIO: OpenPGPFileIO; macosDesktop: boolean } {
  return { fileIO: createAppFileIO(), macosDesktop: isMacosDesktop() }
}
