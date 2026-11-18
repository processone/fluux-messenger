// The account's OMEMO devices, as other apps published them, with a confirmed Remove.
// Reads and edits the two device lists (OMEMO 2 and legacy) directly: it registers no plugin, saves no trust and
// makes Fluux no device, so it works before OMEMO is turned on and stores nothing on this device.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Smartphone, Trash2 } from 'lucide-react'
import { useConnection, useXMPPContext, getBareJid } from '@fluux/sdk'
import {
  pepAccessFor,
  readOwnDeviceLists,
  removeOwnDevices,
  type DeviceListProtocol,
  type DeviceListRead,
  type OwnDevice,
  type OwnDeviceLists,
} from '@fluux/omemo-plugin/devices'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useToastStore } from '@/stores/toastStore'

const PROTOCOLS: readonly DeviceListProtocol[] = ['omemo2', 'legacy']

type LoadState = { kind: 'loading' } | { kind: 'loaded'; lists: OwnDeviceLists } | { kind: 'failed' }

/** The 64 hex characters of a key in groups of 8, so they can be compared by eye. */
function groupFingerprint(fp: string): string {
  return fp.match(/.{1,8}/g)?.join(' ') ?? fp
}

export function OmemoDevicesSection() {
  const { t } = useTranslation()
  const { status, jid } = useConnection()
  const { client } = useXMPPContext()
  const addToast = useToastStore((s) => s.addToast)
  const online = status === 'online' && !!jid
  const accountJid = jid ? getBareJid(jid) : ''

  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [pending, setPending] = useState<{ protocol: DeviceListProtocol; device: OwnDevice } | null>(null)
  const [removing, setRemoving] = useState(false)
  // A reading that finishes after a newer one started, or after the account changed, is dropped.
  const readCounter = useRef(0)

  const load = useCallback(async () => {
    const mine = ++readCounter.current
    setState({ kind: 'loading' })
    try {
      const lists = await readOwnDeviceLists(pepAccessFor(client), accountJid)
      if (mine === readCounter.current) setState({ kind: 'loaded', lists })
    } catch {
      if (mine === readCounter.current) setState({ kind: 'failed' })
    }
  }, [client, accountJid])

  useEffect(() => {
    if (!online) {
      readCounter.current++
      return
    }
    void load()
  }, [online, load])

  const confirmRemove = async () => {
    if (!pending || removing) return
    const { protocol, device } = pending
    setRemoving(true)
    try {
      await removeOwnDevices(pepAccessFor(client), accountJid, protocol, [device.id])
      addToast('success', t('settings.encryption.omemoDevices.removed'))
    } catch {
      addToast('error', t('settings.encryption.omemoDevices.removeFailed'))
    } finally {
      setRemoving(false)
      setPending(null)
      // Show what the account holds now, whether the removal went through or not.
      void load()
    }
  }

  const deviceName = (d: OwnDevice) => d.label || t('settings.encryption.omemoDevices.unnamed')

  const renderList = (protocol: DeviceListProtocol, read: DeviceListRead) => (
    <div key={protocol} className="space-y-2" data-testid={`omemo-list-${protocol}`}>
      <h4 className="text-sm font-medium text-fluux-text">
        {t(`settings.encryption.omemoDevices.protocol.${protocol}`)}
      </h4>
      {!read.ok ? (
        <p className="text-xs text-fluux-error">{t('settings.encryption.omemoDevices.listUnreadable')}</p>
      ) : read.devices.length === 0 ? (
        <p className="text-xs text-fluux-muted">{t('settings.encryption.omemoDevices.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {read.devices.map((device) => (
            <li
              key={device.id}
              className="flex items-start justify-between gap-3 p-3 rounded-lg bg-fluux-bg border border-fluux-border"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm text-fluux-text">
                  <Smartphone className="size-4 flex-shrink-0 text-fluux-muted" />
                  <span className="truncate">{deviceName(device)}</span>
                </div>
                <p className="mt-0.5 text-xs text-fluux-muted">
                  {t('settings.encryption.omemoDevices.deviceId', { id: device.id })}
                </p>
                <p className="mt-1 text-xs font-mono text-fluux-muted break-all">
                  {device.fingerprint
                    ? groupFingerprint(device.fingerprint)
                    : t('settings.encryption.omemoDevices.noFingerprint')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPending({ protocol, device })}
                disabled={removing}
                aria-label={t('settings.encryption.omemoDevices.removeDevice', { name: deviceName(device) })}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-red/10 hover:bg-fluux-red/20 text-fluux-error rounded transition-colors disabled:opacity-50"
              >
                <Trash2 className="size-3.5" />
                {t('settings.encryption.omemoDevices.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  let body
  if (!online) {
    body = <p className="text-xs text-fluux-muted">{t('settings.encryption.omemoDevices.offline')}</p>
  } else if (state.kind === 'loading') {
    body = <p className="text-xs text-fluux-muted">{t('settings.encryption.omemoDevices.loading')}</p>
  } else if (state.kind === 'failed') {
    body = (
      <div className="space-y-2">
        <p className="text-xs text-fluux-error">{t('settings.encryption.omemoDevices.loadFailed')}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="px-3 py-1.5 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
        >
          {t('settings.encryption.omemoDevices.retry')}
        </button>
      </div>
    )
  } else {
    body = <div className="space-y-4">{PROTOCOLS.map((p) => renderList(p, state.lists[p]))}</div>
  }

  return (
    <>
      <SettingsSection
        title={t('settings.encryption.omemoDevices.title')}
        description={t('settings.encryption.omemoDevices.description')}
        className="mt-8"
      >
        {body}
      </SettingsSection>
      {pending && (
        <ConfirmDialog
          title={t('settings.encryption.omemoDevices.removeTitle')}
          message={t('settings.encryption.omemoDevices.removeMessage', { name: deviceName(pending.device) })}
          confirmLabel={t('settings.encryption.omemoDevices.removeAction')}
          onConfirm={() => void confirmRemove()}
          onCancel={() => {
            if (!removing) setPending(null)
          }}
        />
      )}
    </>
  )
}
