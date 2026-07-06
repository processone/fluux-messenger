/**
 * Tutorial provider — listens for demo:custom events, pauses animation,
 * shows tooltips, and resumes on user action or skip.
 *
 * Tutorial translations live in ./locales/ and are loaded lazily via
 * i18next.addResourceBundle so they never bloat the main translation files.
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { DemoClient, DemoAnimationStep } from '@fluux/sdk/demo'
import { DemoTooltip } from './DemoTooltip'
import { getTutorialStep } from './tutorialSteps'
import { useDemoUploadSimulation, type DemoUploadState } from '../useDemoUploadSimulation'
import type { TutorialStep } from './types'

interface DemoTutorialContextValue {
  tutorialEnabled: boolean
  uploadState: DemoUploadState
}

const DemoTutorialContext = createContext<DemoTutorialContextValue>({
  tutorialEnabled: false,
  uploadState: { isUploading: false, progress: 0, fileName: '', conversationId: null },
})

export function useDemoTutorial() {
  return useContext(DemoTutorialContext)
}

/**
 * All tutorial locale modules, keyed by language code.
 * Vite resolves this glob at build time — only the requested language is loaded at runtime.
 */
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*.ts')

/** Dynamically import tutorial translations for the given language. */
async function loadTutorialLocale(lang: string): Promise<Record<string, unknown> | null> {
  const key = `./locales/${lang}.ts`
  const loader = localeModules[key]
  if (loader) {
    const mod = await loader()
    return mod.default
  }
  // Language not available — fall back to English
  if (lang !== 'en') {
    const enLoader = localeModules['./locales/en.ts']
    if (enLoader) {
      const mod = await enLoader()
      return mod.default
    }
  }
  return null
}

interface DemoTutorialProviderProps {
  enabled: boolean
  client: DemoClient
  animation?: DemoAnimationStep[]
  children: React.ReactNode
}

export function DemoTutorialProvider({ enabled, client, animation, children }: DemoTutorialProviderProps) {
  const [activeStep, setActiveStep] = useState<TutorialStep | null>(null)
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set())
  const clientRef = useRef(client)
  clientRef.current = client

  const { i18n } = useTranslation()

  // Load tutorial translations for the current language
  useEffect(() => {
    if (!enabled) return

    const lang = i18n.language ?? 'en'
    // Skip if already loaded for this language
    if (i18n.hasResourceBundle(lang, 'tutorial')) return

    void loadTutorialLocale(lang).then(resources => {
      if (resources) {
        i18n.addResourceBundle(lang, 'tutorial', resources, true, true)
      }
    })
  }, [enabled, i18n, i18n.language])

  // Upload simulation runs regardless of tutorial mode
  const uploadState = useDemoUploadSimulation(client)

  // Listen for demo:custom events
  useEffect(() => {
    if (!enabled) return

    const handler = (payload: { type: string; [key: string]: unknown }) => {
      if (payload.type !== 'tutorial') return

      const stepId = payload.stepId as string
      if (!stepId || completedSteps.has(stepId)) return

      const step = getTutorialStep(stepId)
      if (!step) return

      // Check if target element exists (skip if not visible)
      const target = document.querySelector(step.targetSelector)
      if (!target && step.targetSelector !== 'body') {
        // Target not found — skip this step, don't pause
        return
      }

      // Pause animation and show tooltip
      clientRef.current.pauseAnimation()
      setActiveStep(step)
    }

    const unsubscribe = client.subscribe('demo:custom', handler)
    return unsubscribe
  }, [enabled, client, completedSteps])

  // Start animation inside React lifecycle so StrictMode's
  // destroy/remount cycle cannot kill timers permanently.
  useEffect(() => {
    if (!animation || animation.length === 0) return
    const stop = client.startAnimation(animation)
    return stop
  }, [client, animation])

  const handleComplete = useCallback(() => {
    if (activeStep) {
      setCompletedSteps(prev => new Set(prev).add(activeStep.id))
    }
    setActiveStep(null)
    clientRef.current.resumeAnimation()
  }, [activeStep])

  const handleSkip = useCallback(() => {
    if (activeStep) {
      setCompletedSteps(prev => new Set(prev).add(activeStep.id))
    }
    setActiveStep(null)
    clientRef.current.resumeAnimation()
  }, [activeStep])

  return (
    <DemoTutorialContext.Provider value={{ tutorialEnabled: enabled, uploadState }}>
      {children}
      {activeStep && (
        <DemoTooltip
          key={activeStep.id}
          step={activeStep}
          onSkip={handleSkip}
          onComplete={handleComplete}
        />
      )}
    </DemoTutorialContext.Provider>
  )
}
