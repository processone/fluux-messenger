/**
 * Tutorial provider — listens for demo:custom events, pauses animation,
 * shows tooltips, and resumes on user action or skip.
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import type { DemoClient } from '@fluux/sdk'
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

interface DemoTutorialProviderProps {
  enabled: boolean
  client: DemoClient
  children: React.ReactNode
}

export function DemoTutorialProvider({ enabled, client, children }: DemoTutorialProviderProps) {
  const [activeStep, setActiveStep] = useState<TutorialStep | null>(null)
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set())
  const clientRef = useRef(client)
  clientRef.current = client

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
