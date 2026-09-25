import { platform } from '@/platform'

/** Keep the mobile app at its layout scale while preserving one-finger gestures. */
export function installMobilePageZoom(): () => void {
  const isMobile = () => platform().shell === 'mobile' || window.matchMedia('(any-pointer: coarse)').matches
  const preventGesture = (event: Event) => {
    if (isMobile() && event.cancelable) event.preventDefault()
  }
  const preventPinch = (event: TouchEvent) => {
    if (event.touches.length > 1) preventGesture(event)
  }

  // Safari may allow pinch zoom despite viewport scale restrictions.
  document.addEventListener('gesturestart', preventGesture, { passive: false })
  document.addEventListener('gesturechange', preventGesture, { passive: false })
  document.addEventListener('touchmove', preventPinch, { passive: false })
  return () => {
    document.removeEventListener('gesturestart', preventGesture)
    document.removeEventListener('gesturechange', preventGesture)
    document.removeEventListener('touchmove', preventPinch)
  }
}
