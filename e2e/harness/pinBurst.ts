import type { Page, TestInfo } from '@playwright/test'

/**
 * Capture SDK emissions, DOM commits and scroll decisions. Every `at` uses page performance time;
 * a controlled clock pauses between model frames, so those timestamps are not wall-clock latency.
 */
export async function armPinBurst(
  page: Page,
  messageId: string,
  previewUrl: string,
  clockDomain: 'native-performance' | 'playwright-controlled-performance',
): Promise<void> {
  await page.evaluate(({ messageId, previewUrl, clockDomain }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    const events: Array<Record<string, unknown>> = []
    let generation: number | null = null
    let active = false
    const commits = new Set<string>()
    const geometry = () => {
      const scroller = document.querySelector<HTMLElement>('[data-message-list]')
      const row = scroller?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
      return {
        scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight,
        clientHeight: scroller?.clientHeight,
        spacerHeight: scroller?.firstElementChild?.getBoundingClientRect().height,
        rowHeight: row?.getBoundingClientRect().height,
        rowBottom: row?.getBoundingClientRect().bottom,
        viewportBottom: scroller?.getBoundingClientRect().bottom,
      }
    }
    const record = (event: string, data?: unknown) => {
      events.push({ at: performance.now(), event, generation, active, data, geometry: geometry() })
    }
    w.__fluuxPinBurstObserve = (args: unknown[]) => {
      const head = args[0]
      const data = args[1] as Record<string, unknown> | undefined
      if (typeof head === 'string' && /\[(Scroll|ScrollStateManager|PinLoopProbe|PinBurstProbe)\]/.test(head)) {
        if (head === '[Scroll] PIN start' && data?.trigger === 'new-message' && generation === null) {
          generation = Number(data.generation)
          active = true
        }
        scanCommits()
        record(head, data)
        if (head === '[Scroll] PIN completed' && data?.generation === generation) active = false
      }
    }
    if (!w.__fluuxPinBurstHooked) {
      w.__fluuxPinBurstHooked = true
      for (const level of ['warn', 'log'] as const) {
        const original = console[level].bind(console)
        console[level] = (...args: unknown[]) => {
          try {
            w.__fluuxPinBurstObserve?.(args)
          } catch (error) {
            w.__fluuxPinBurst?.events.push({ at: performance.now(), event: 'probe error', data: String(error) })
          }
          original(...args)
        }
      }
    }
    const originalEmit = w.__demoClient.emitSDK.bind(w.__demoClient)
    w.__demoClient.emitSDK = (event: string, data: { messageId?: string; message?: { id?: string } }) => {
      if (data?.messageId === messageId || data?.message?.id === messageId) record(`SDK ${event}`, data)
      return originalEmit(event, data)
    }
    const scanCommits = () => {
      const row = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
      const found = [
        ['message', !!row],
        ['preview', !!row?.querySelector(`a[href="${previewUrl}"]`)],
        ['reaction', !!row?.querySelector('[data-reaction-emoji]')],
      ] as const
      for (const [label, present] of found) {
        if (present && !commits.has(label)) {
          commits.add(label)
          record(`commit ${label}`)
        }
      }
    }
    const observer = new MutationObserver(scanCommits)
    observer.observe(document.querySelector('[data-message-list]')!, { childList: true, subtree: true, attributes: true })
    w.__fluuxPinBurst = {
      clockDomain,
      events,
      stop: () => {
        record('pin model', w.__fluuxPinModel)
        record('final')
        observer.disconnect()
        w.__fluuxPinBurstObserve = undefined
        w.__demoClient.emitSDK = originalEmit
      },
    }
    record('armed')
  }, { messageId, previewUrl, clockDomain })
}

export async function finishPinBurst(page: Page, testInfo: TestInfo): Promise<void> {
  const trace = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe = (window as any).__fluuxPinBurst
    probe.stop()
    return { clockDomain: probe.clockDomain as string, timestampUnit: 'milliseconds',
      events: probe.events as Array<{ event: string; active: boolean }> }
  })
  await testInfo.attach('pin-burst-scroll-trace', {
    body: JSON.stringify(trace, null, 2), contentType: 'application/json',
  })
  if (trace.events.some(event => event.event === 'probe error')) throw new Error('pin-burst scroll trace could not be captured')
}
