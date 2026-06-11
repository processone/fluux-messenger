import { isTauri } from './tauri'

/**
 * Download a file from a URL.
 * In Tauri, uses the native save dialog + fs plugin because the webview
 * ignores the <a download> attribute and navigates to the URL instead.
 */
export async function downloadFile(url: string, filename: string): Promise<void> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeFile } = await import('@tauri-apps/plugin-fs')

    const savePath = await save({ defaultPath: filename })
    if (!savePath) return

    const response = await fetch(url)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await writeFile(savePath, bytes)
  } else {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }
}
