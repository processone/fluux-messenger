/**
 * Place one "missing messages" marker per recorded history gap.
 *
 * A gap starts at the newest message held below it, so its marker sits on the
 * first message newer than that start. A gap whose upper edge (`end`) is older
 * than this window's first message lies entirely below the window: it gets no
 * marker here and shows once the user scrolls back to it.
 *
 * @param groups - Messages grouped by day, in chronological order
 * @param gaps - Recorded gaps, oldest first
 * @returns Message → start of the gap its marker fills
 */
export function gapMarkerPositions<T extends { timestamp: Date }>(
  groups: ReadonlyArray<{ messages: readonly T[] }>,
  gaps: ReadonlyArray<{ start: number; end?: number }> | undefined,
): Map<T, number> {
  const positions = new Map<T, number>()
  const firstTs = groups.find((group) => group.messages.length > 0)?.messages[0].timestamp.getTime()
  if (!gaps || firstTs === undefined) return positions
  const starts = gaps.filter((gap) => gap.end === undefined || gap.end >= firstTs).map((gap) => gap.start)

  let gapIndex = 0
  for (const group of groups) {
    for (const message of group.messages) {
      if (gapIndex >= starts.length) return positions
      const ts = message.timestamp.getTime()
      let firstCovered: number | undefined
      while (gapIndex < starts.length && ts > starts[gapIndex]) {
        firstCovered ??= starts[gapIndex]
        gapIndex++
      }
      if (firstCovered !== undefined) positions.set(message, firstCovered)
    }
  }
  return positions
}
