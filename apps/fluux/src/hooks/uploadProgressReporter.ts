/**
 * Upload progress reporter for XEP-0363 HTTP File Upload.
 *
 * Combines the main-file and (optional) thumbnail upload progress into one
 * size-weighted 0-100 percent, and emits only when that rounded percent
 * actually changes.
 *
 * Why the changed-value gate: on the web (XHR) path, `xhr.upload.onprogress`
 * fires per network buffer flush, and the previous code called `setState` on
 * every event — building a fresh state object each time even when the rounded
 * percent hadn't moved. That re-rendered the conversation pane redundantly.
 * The updater had the same class of bug (issue #994); uploads are milder
 * because the value is already integer-quantized, so a plain dedupe (rather
 * than a time throttle) is enough: it caps emits at ~one per whole percent.
 *
 * The baseline starts at 0 to match `useFileUpload`'s initial `progress: 0`
 * state, so an opening `setMain(0)` doesn't emit a redundant 0.
 */
export interface UploadProgressReporter {
  /** Report the main file's upload progress (0-100). */
  setMain(progress: number): void
  /** Report the thumbnail's upload progress (0-100). */
  setThumbnail(progress: number): void
}

export function createUploadProgressReporter(
  fileSize: number,
  thumbnailSize: number,
  emit: (overall: number) => void,
): UploadProgressReporter {
  const totalSize = fileSize + thumbnailSize
  let mainProgress = 0
  let thumbProgress = 0
  let lastOverall = 0

  const flush = () => {
    const overall =
      totalSize > 0
        ? Math.round((mainProgress * fileSize + thumbProgress * thumbnailSize) / totalSize)
        : 0
    if (overall === lastOverall) return
    lastOverall = overall
    emit(overall)
  }

  return {
    setMain(progress) {
      mainProgress = progress
      flush()
    },
    setThumbnail(progress) {
      thumbProgress = progress
      flush()
    },
  }
}
