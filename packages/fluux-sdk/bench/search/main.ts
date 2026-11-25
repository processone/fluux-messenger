import { getDemoMessages } from 'virtual:search-corpus'
import { measureSearchHistory } from '../searchIndex.harness'
import * as candidate from '../../src/utils/searchIndex'

const corpus = [...getDemoMessages().values()].flat().filter(message => message.body && !message.isRetracted)

async function checkSearchBench() {
  const historical = await import('virtual:search-index-v5')
  if (typeof historical.search !== 'function' || typeof historical.closeSearchIndex !== 'function' || !corpus.length) {
    throw new Error('The historical index or conversation corpus is unavailable')
  }
  return { corpusMessages: corpus.length }
}

async function runSearchBench(variant: 'version5' | 'candidate') {
  const engine = variant === 'version5' ? await import('virtual:search-index-v5') : candidate
  const result = await measureSearchHistory(corpus, engine, variant)
  const out = document.getElementById('out')
  if (out) out.textContent = JSON.stringify(result, null, 2)
  return result
}

declare global {
  interface Window {
    runSearchBench: typeof runSearchBench
    checkSearchBench: typeof checkSearchBench
  }
}
window.runSearchBench = runSearchBench
window.checkSearchBench = checkSearchBench
