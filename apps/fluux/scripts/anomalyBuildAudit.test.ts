import { describe, expect, it } from 'vitest'
import { auditBundle } from './anomalyBuildAudit'

const withAnomaly = {
  'assets/index-abc.js': {
    type: 'chunk',
    modules: {
      '/repo/apps/fluux/src/anomaly/recorder.ts': {},
      '/repo/apps/fluux/src/App.tsx': {},
    },
  },
  'assets/other-def.js': { type: 'chunk', modules: { '/repo/apps/fluux/src/main.tsx': {} } },
}

const withoutAnomaly = {
  'assets/other-def.js': { type: 'chunk', modules: { '/repo/apps/fluux/src/main.tsx': {} } },
}

describe('auditBundle', () => {
  it('passes a production bundle with no anomaly modules', () => {
    expect(() => auditBundle(withoutAnomaly, false)).not.toThrow()
  })

  it('fails a production bundle that still contains anomaly modules', () => {
    expect(() => auditBundle(withAnomaly, false)).toThrow(/anomaly/i)
  })

  it('fails a production bundle containing anomaly-only support', () => {
    const withSupport = {
      'assets/index-abc.js': {
        type: 'chunk',
        modules: {
          '/repo/apps/fluux/src/utils/viewportScroller.ts': {},
          '/repo/apps/fluux/src/ChatView.tsx': {},
        },
      },
    }
    expect(() => auditBundle(withSupport, false)).toThrow(/viewportScroller\.ts/)
  })

  it('fails a Dev bundle that is MISSING the anomaly modules', () => {
    // The direction that would silently regress to "eliminated everywhere,
    // including where it was supposed to run" — which is what import.meta.env.DEV
    // did before #1167. Asserting only absence would pass vacuously here.
    expect(() => auditBundle(withoutAnomaly, true)).toThrow(/expected/i)
  })

  it('fails a Dev bundle containing only anomaly support', () => {
    const withSupportOnly = {
      'assets/index-abc.js': {
        type: 'chunk',
        modules: {
          '/repo/apps/fluux/src/utils/viewportScroller.ts': {},
          '/repo/apps/fluux/src/ChatView.tsx': {},
        },
      },
    }
    expect(() => auditBundle(withSupportOnly, true)).toThrow(/expected/i)
  })

  it('passes a Dev bundle containing the anomaly modules', () => {
    expect(() => auditBundle(withAnomaly, true)).not.toThrow()
  })

  it('names the offending modules so the failure is actionable', () => {
    expect(() => auditBundle(withAnomaly, false)).toThrow(/recorder\.ts/)
  })

  it('inspects the module graph, not chunk filenames', () => {
    // A module inlined into an existing chunk has no distinguishing filename, so a
    // filename check would pass while the code shipped.
    const inlined = {
      'assets/vendor-xyz.js': {
        type: 'chunk',
        modules: { '/repo/apps/fluux/src/anomaly/values.ts': {} },
      },
    }
    expect(() => auditBundle(inlined, false)).toThrow(/values\.ts/)
  })

  it('ignores assets that are not chunks', () => {
    const withAsset = {
      'assets/style.css': { type: 'asset' },
      ...withoutAnomaly,
    }
    expect(() => auditBundle(withAsset, false)).not.toThrow()
  })

  it('matches the anomaly directory on both path separators', () => {
    const windowsPath = {
      'assets/index.js': {
        type: 'chunk',
        modules: { 'C:\\repo\\apps\\fluux\\src\\anomaly\\values.ts': {} },
      },
    }
    expect(() => auditBundle(windowsPath, false)).toThrow(/anomaly/i)
  })

  it('does not mistake a similarly named directory for the anomaly tree', () => {
    // `src/anomalyReports/` is not `src/anomaly/`; a substring match would flag it.
    const lookalike = {
      'assets/index.js': {
        type: 'chunk',
        modules: { '/repo/apps/fluux/src/anomalyReports/thing.ts': {} },
      },
    }
    expect(() => auditBundle(lookalike, false)).not.toThrow()
  })
})
