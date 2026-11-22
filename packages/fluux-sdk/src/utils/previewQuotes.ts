/**
 * Quote stripping for notification and conversation previews.
 *
 * Dependency-free on purpose: the web push service worker imports this file
 * directly and must not pull in the SDK. The iOS notification extension keeps a
 * Swift twin of this rule (`NotificationContent.previewText`); both are pinned
 * by tests/fixtures/notification-content.json.
 *
 * Rule: drop every line starting with `>` that is outside a code fence, then trim.
 * The rule is idempotent. A text made only of quote lines keeps its quote, `>` included, so the preview
 * shows what was sent instead of reading as the sender's own words.
 */
export function stripQuotedLines(text: string): string {
  if (!text || !text.includes('>')) return text

  const kept: string[] = []
  let inFence = false
  let dropped = false
  // CRLF and lone CR separate lines too.
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!inFence && line.startsWith('>')) {
      dropped = true
      continue
    }
    // An odd number of fence markers on a line opens or closes a fenced block.
    if ((line.split('```').length - 1) % 2 === 1) inFence = !inFence
    kept.push(line)
  }
  if (!dropped) return text

  // Trim whole blank lines, never the first line's indent: removing it could turn an indented
  // `  > x` into a `>` line, and filtering twice (Rust, then Swift) must give the same text.
  const first = kept.findIndex(line => line.trim())
  const remaining = first < 0 ? '' : kept.slice(first).join('\n').trimEnd()
  return remaining ? remaining : text.trim()
}
