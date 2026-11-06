/** Native desktop availability is session-scoped: an unbundled development process has no
 * optional writer library. Once native reports that absence, neither producer should rebuild
 * and resend the same metadata on every store change. iOS's void replies leave this unchanged. */
export interface WidgetWriteResult {
  written?: boolean
  supported?: boolean
}

let supported = true

export function widgetSessionSupported(): boolean { return supported }

export function observeWidgetSupport(result: WidgetWriteResult | undefined): boolean {
  if (result?.supported === false) supported = false
  return supported
}

/** Reset only between isolated tests, never on account replacement in a running app. */
export function resetWidgetSupportForTesting(): void { supported = true }
