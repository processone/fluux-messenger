import { getMimeType, getFilename } from '@/utils/fileUtils'

/** Reads a file dropped on the desktop window into a File. */
export async function readNativeDroppedFile(path: string): Promise<File> {
  // Dynamic import to avoid loading the Tauri API in the browser
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const filename = getFilename(path)
  const contents = await readFile(path)
  return new File([contents], filename, { type: getMimeType(filename) })
}
