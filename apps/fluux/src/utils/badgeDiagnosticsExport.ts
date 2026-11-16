import { exportBadgeDiagnostics } from './badgeDiagnostics'
import { downloadFile } from './download'

/** A separate export: never includes the XMPP console's potentially private payloads. */
export async function saveBadgeDiagnostics(errorMessage: string): Promise<void> {
  const content = JSON.stringify({ ...JSON.parse(exportBadgeDiagnostics()), appVersion: __APP_VERSION__, appCommit: __GIT_COMMIT__ })
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    await downloadFile(url, 'fluux-badge-diagnostics.json', { errorMessage })
  } finally {
    URL.revokeObjectURL(url)
  }
}
