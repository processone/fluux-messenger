import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Github, Copy, Check } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { ModalShell } from './ModalShell'

interface AboutModalProps {
  onClose: () => void
}

export function AboutModal({ onClose }: AboutModalProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copyVersionInfo = async () => {
    const info = `Fluux Messenger ${__APP_VERSION__}\nCommit: ${__GIT_COMMIT__}`
    try {
      await navigator.clipboard.writeText(info)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <ModalShell title={t('about.title')} onClose={onClose} width="w-80">
      <div className="p-6 text-center">
        <img
          src="/logo.png"
          alt="Fluux Messenger"
          className="w-16 h-16 mx-auto mb-4"
        />
        <h3 className="text-xl font-bold text-fluux-text mb-1">Fluux Messenger</h3>
        <p className="text-fluux-muted text-sm mb-1">
          {t('about.version', { version: __APP_VERSION__ })}
        </p>
        <p className="text-fluux-brand text-xs font-medium mb-2">
          {t('about.edition')}
        </p>
        <div className="flex items-center justify-center gap-2 mb-4">
          <p className="text-fluux-muted text-xs font-mono">
            {__GIT_COMMIT__}
          </p>
          <Tooltip content={copied ? t('common.copied') : t('about.copyVersionInfo')}>
            <button
              onClick={copyVersionInfo}
              className="p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-green-500" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </Tooltip>
        </div>
        <p className="text-fluux-text text-sm mb-4">
          {t('about.description')}
        </p>
        <a
          href="https://github.com/processone/fluux-messenger"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-fluux-muted text-xs hover:text-fluux-brand mb-4"
        >
          <Github className="w-3.5 h-3.5" />
          {t('about.viewOnGithub')}
        </a>
        <p className="text-fluux-muted text-xs mb-3">
          {t('about.madeBy')}{' '}
          <a
            href="https://www.process-one.net"
            target="_blank"
            rel="noopener noreferrer"
            className="text-fluux-brand hover:underline"
          >
            ProcessOne
          </a>
        </p>
        <p className="text-fluux-muted text-xs">
          {t('about.commercialLicense')}{' '}
          <a
            href="https://www.process-one.net/contact/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-fluux-brand hover:underline"
          >
            {t('about.contactUs')}
          </a>.
        </p>
      </div>
    </ModalShell>
  )
}
