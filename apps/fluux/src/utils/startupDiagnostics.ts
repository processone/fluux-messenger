/**
 * One-shot startup diagnostics line for fluux.log.
 *
 * Records engine capabilities that silently change how fixes behave in the
 * field. Motivating case: the message-list perf fix relies on
 * `content-visibility: auto` — engines that predate it (WebKitGTK < 2.46)
 * ignore the property and the fix is a no-op. Without this line, a "still
 * freezing on 0.16.1" report is ambiguous; with it, the first grep answers
 * whether the fix could even apply.
 */
export function formatStartupCapabilities(
  supports: (property: string, value: string) => boolean,
  userAgent: string
): string {
  let contentVisibility: string
  try {
    contentVisibility = supports('content-visibility', 'auto') ? 'supported' : 'UNSUPPORTED'
  } catch {
    contentVisibility = 'unknown'
  }

  return (
    `[StartupDiagnostics] content-visibility=${contentVisibility} ua=${userAgent}`
  )
}

/** Log the capabilities line once (console.info → forwarded to fluux.log). */
export function logStartupCapabilities(): void {
  console.info(
    formatStartupCapabilities(
      (property, value) => CSS.supports(property, value),
      navigator.userAgent
    )
  )
}
