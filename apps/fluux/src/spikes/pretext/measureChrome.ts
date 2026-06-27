/**
 * Reads the fixed, text-independent vertical chrome of a message row so the
 * spike can report `predictedRowHeight = predictTextHeight(...) + chromeDeltaPx`.
 * Pass DOM nodes the harness has already rendered.
 */
export interface ChromeDeltas {
  rowVerticalPaddingPx: number
  senderHeaderPx: number
  reactionsRowPx: number
  dateSeparatorPx: number
}

export function measureChrome(nodes: {
  rowPaddingProbe: HTMLElement | null
  senderHeader: HTMLElement | null
  reactionsRow: HTMLElement | null
  dateSeparator: HTMLElement | null
}): ChromeDeltas {
  const h = (el: HTMLElement | null) => (el ? el.getBoundingClientRect().height : 0)
  return {
    rowVerticalPaddingPx: h(nodes.rowPaddingProbe),
    senderHeaderPx: h(nodes.senderHeader),
    reactionsRowPx: h(nodes.reactionsRow),
    dateSeparatorPx: h(nodes.dateSeparator),
  }
}
