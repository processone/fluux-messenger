import { useTranslation } from 'react-i18next'
import { ShieldAlert, AlertTriangle } from 'lucide-react'
import { extractTransportErrorClass, type ConnectionErrorKind, type DiscoveryFailure } from '@fluux/sdk'

interface LoginErrorPanelProps {
  kind: ConnectionErrorKind
  /** Raw SDK error string. Used for the cert sub-class and the fallback render. */
  rawError: string
  discoveryFailure?: DiscoveryFailure | null
}

/** Map a cert sub-class (from `extractTransportErrorClass`) to its body i18n key. */
function certBodyKey(sub: string | null): string {
  switch (sub) {
    case 'certificate-expired':
      return 'expired'
    case 'certificate-name-mismatch':
      return 'nameMismatch'
    case 'certificate-untrusted':
      return 'untrusted'
    default:
      return 'generic'
  }
}

const plainBoxClass =
  'p-3 bg-fluux-red/20 border border-fluux-red/50 rounded-lg text-fluux-error text-sm'

export function LoginErrorPanel({ kind, rawError, discoveryFailure }: LoginErrorPanelProps) {
  const { t } = useTranslation()

  const discoveryHint = discoveryFailure ? (
    <p className="mt-2 break-words">
      {t(discoveryFailure.transport === 'native-tcp' ? 'login.errors.discoveryFailedTcp' : 'login.errors.discoveryFailed', {
        domain: discoveryFailure.domain,
        target: discoveryFailure.target,
      })}
    </p>
  ) : null

  if (kind === 'auth' || kind === 'unknown') {
    return <div className={plainBoxClass}>{rawError}{discoveryHint}</div>
  }

  let title: string
  let body: string
  if (kind === 'tls-certificate') {
    title = t('login.errors.tlsCertTitle')
    body = t(`login.errors.cert.${certBodyKey(extractTransportErrorClass(rawError))}`)
  } else if (kind === 'timeout') {
    title = t('login.errors.unreachableTitle')
    body = t('login.errors.timeoutBody')
  } else if (kind === 'connection-refused') {
    title = t('login.errors.unreachableTitle')
    body = t('login.errors.refusedBody')
  } else {
    // tls-other
    title = t('login.errors.tlsOtherTitle')
    body = t('login.errors.tlsOtherBody')
  }

  const Icon = kind === 'tls-certificate' ? ShieldAlert : AlertTriangle

  return (
    <div role="alert" className={`${plainBoxClass} flex gap-2`}>
      <Icon className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        <p className="text-fluux-error/90">{body}</p>
        {discoveryHint}
      </div>
    </div>
  )
}
