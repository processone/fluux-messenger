/** Keep failed text recoverable without replacing the user's newer draft. */
export function mergeFailedDraft(current: string, failed: string): string {
  if (!failed.trim() || current === failed) return current
  return current ? `${current}\n\n${failed}` : failed
}
