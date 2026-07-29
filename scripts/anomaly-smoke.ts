import { expect, test } from '@playwright/test'

/**
 * The bundle checks prove the anomaly code is PRESENT in a Dev build. They cannot
 * prove it RUNS — a module that ships but never installs would satisfy both of
 * them. This is the only gate that exercises the runtime end to end.
 *
 * Chromium only, deliberately: the assertions read a JavaScript global and are
 * engine-independent, so a second engine would double the cost for no signal. The
 * scroll and composer suites run on both because they measure layout, which is
 * exactly where the engines differ.
 */
test.describe('anomaly runtime', () => {
  test('the Dev build emits exactly one session-start record', async ({ page }) => {
    await page.goto('/demo.html?tutorial=false')

    // The record is written only after the tokenizer resolves its key, so poll
    // rather than sampling once.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const lines = (window as unknown as { __fluuxAnomalies?: string[] })
              .__fluuxAnomalies
            if (!lines) return null
            return lines
              .map((l) => JSON.parse(l) as { id?: string })
              .filter((r) => r.id === 'recorder/session-start').length
          }),
        {
          timeout: 30_000,
          message: 'the anomaly runtime never wrote its session record',
        },
      )
      .toBe(1)

    const record = await page.evaluate(
      () =>
        (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((r) => r.id === 'recorder/session-start')!,
    )

    // `tokenKeyId` is the correlation boundary: "unknown" means the record was
    // written before the tokenizer was ready and cannot be attributed to a token
    // space, which is the failure the readiness gate exists to prevent.
    expect(record.tokenKeyId).toMatch(/^[0-9a-f]{8}$/)
    expect(record.sid).toBeTruthy()
    expect(record.v).toBe(1)
    expect(record.sev).toBe('drift')

    // The runtime sentinel — the same string the bundle grep looks for. Present
    // here proves the marker is reachable at runtime, not merely compiled in.
    const sentinel = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__fluuxAnomalyBuild,
    )
    expect(sentinel).toBe('fluux-anomaly-instrumentation-present')
  })

  test('React StrictMode does not duplicate the session record', async ({ page }) => {
    // The demo tree mounts under StrictMode, so every effect runs
    // install → cleanup → install. A per-attachment announcement would emit twice;
    // the cooldown would hide the second record but still count a phantom
    // suppression, so assert the digest as well as the record count.
    await page.goto('/demo.html?tutorial=false')

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            ((window as unknown as { __fluuxAnomalies?: string[] }).__fluuxAnomalies ?? [])
              .length,
        ),
      )
      .toBeGreaterThan(0)

    const summary = await page.evaluate(() => {
      const w = window as unknown as { __fluuxAnomalies: string[] }
      const records = w.__fluuxAnomalies.map((l) => JSON.parse(l) as Record<string, unknown>)
      return {
        starts: records.filter((r) => r.id === 'recorder/session-start').length,
        ceilings: records.filter((r) => r.id === 'recorder/ceiling-reached').length,
      }
    })

    expect(summary.starts).toBe(1)
    // A ceiling in a freshly loaded demo would mean the budget accounting is wrong.
    expect(summary.ceilings).toBe(0)
  })
})
