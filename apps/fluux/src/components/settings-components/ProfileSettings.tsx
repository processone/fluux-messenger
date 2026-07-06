import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getBareJid, getLocalPart, useConnection, usePresence } from '@fluux/sdk'
import { AvatarCropModal } from '../AvatarCropModal'
import { ChangePasswordModal } from '../ChangePasswordModal'
import { OwnProfileHero } from './profile/OwnProfileHero'
import { VCardSection } from './profile/VCardSection'
import { DevicesSection } from './profile/DevicesSection'
import { AccountSection } from './profile/AccountSection'

/**
 * Profile settings - displays and allows editing of user profile information.
 * Mirrors the contact profile layout: hero (avatar + identity row) followed by
 * stacked sections (vCard, devices, account).
 */
export function ProfileSettings() {
  const { t } = useTranslation()
  const {
    jid,
    isConnected,
    ownAvatar,
    ownNickname,
    setOwnNickname,
    setOwnAvatar,
    clearOwnAvatar,
    clearOwnNickname,
  } = useConnection()
  const { presenceStatus: presenceShow, statusMessage } = usePresence()

  const [showAvatarModal, setShowAvatarModal] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)

  const bareJid = jid ? getBareJid(jid) : ''
  const localPart = jid ? getLocalPart(jid) : ''

  return (
    <div className="w-full max-w-2xl mx-auto">
      {!isConnected && (
        <div className="mx-4 md:mx-6 mt-4 px-3 py-2 bg-fluux-bg rounded-lg text-center">
          <p className="text-sm text-fluux-muted">{t('profile.offlineNotice')}</p>
        </div>
      )}

      <OwnProfileHero
        jid={jid || ''}
        bareJid={bareJid}
        localPart={localPart}
        ownNickname={ownNickname}
        ownAvatar={ownAvatar}
        presenceShow={presenceShow}
        statusMessage={statusMessage}
        isConnected={isConnected}
        onOpenAvatarModal={() => setShowAvatarModal(true)}
        onClearAvatar={clearOwnAvatar}
        onSetNickname={setOwnNickname}
        onClearNickname={clearOwnNickname}
      />

      <div className="py-4 md:py-5 space-y-5">
        <VCardSection />
        <DevicesSection />
        <AccountSection onChangePassword={() => setShowPasswordModal(true)} />
      </div>

      <AvatarCropModal
        isOpen={showAvatarModal}
        onClose={() => setShowAvatarModal(false)}
        onSave={setOwnAvatar}
      />

      {showPasswordModal && (
        <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />
      )}
    </div>
  )
}
