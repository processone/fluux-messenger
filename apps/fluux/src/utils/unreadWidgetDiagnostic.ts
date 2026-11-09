import type { BadgeDiagnosticStep } from './pushBadge'

/** Closed, identity-free observations carried only by the existing voluntary export. */
export interface WidgetPublisherDiagnostic {
  observedAt: number
  online: boolean | null
  verifying: boolean | null
  catchingUp: boolean | null
  replaying: boolean | null
  badgeCommand: 'unknown' | 'emitted'
  badgeAcknowledgement: 'unknown' | 'pending' | 'accepted' | 'rejected'
}

type Attempt = {
  owner: string | null
  command: WidgetPublisherDiagnostic['badgeCommand']
  acknowledgement: WidgetPublisherDiagnostic['badgeAcknowledgement']
}
let last: Attempt | undefined

/** The owner never leaves memory. Late completions cannot replace a newer attempt. */
export function observeWidgetBadge(owner: string | null): (step: BadgeDiagnosticStep) => void {
  const attempt: Attempt = { owner, command: 'unknown', acknowledgement: 'unknown' }
  last = attempt
  return step => {
    if (last !== attempt) return
    if (step === 'issued') {
      attempt.command = 'emitted'
      attempt.acknowledgement = 'pending'
    } else if (attempt.command === 'emitted') {
      attempt.acknowledgement = step === 'acknowledged' ? 'accepted' : 'rejected'
    }
  }
}

export function resetWidgetPublisherDiagnostic(): void { last = undefined }

/** Samples store facts, not a reason inferred from missing native journal entries. */
export function widgetPublisherDiagnostic(input: {
  active: boolean
  owner: string | null
  online: boolean | null
  verifying: boolean | null
  catchingUp: boolean | null
  replaying: boolean | null
}, now = Date.now() / 1000): WidgetPublisherDiagnostic {
  const known = input.active && input.owner !== null
  const attempt = known && last?.owner === input.owner ? last : undefined
  return {
    observedAt: now,
    online: known ? input.online : null,
    verifying: known ? input.verifying : null,
    catchingUp: known ? input.catchingUp : null,
    replaying: known ? input.replaying : null,
    badgeCommand: attempt?.command ?? 'unknown',
    badgeAcknowledgement: attempt?.acknowledgement ?? 'unknown',
  }
}
