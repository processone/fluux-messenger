import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { savedStore } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'

/** One error toast each time the server definitively refuses to store a saved message. */
export function useSavedRefusalToast() {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  useEffect(() => {
    let seen = savedStore.getState().refusals
    return savedStore.subscribe((state) => {
      if (state.refusals === seen) return
      seen = state.refusals
      addToast('error', t('saved.refused'))
    })
  }, [t, addToast])
}
