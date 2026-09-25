import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function qualificationErrors(matrix, evidence, commit) {
  const errors = []
  if (!matrix.environments.length || !matrix.scenarios.length) errors.push('The qualification matrix must not be empty')
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) errors.push('An exact 40-character commit SHA is required')
  if (!Array.isArray(evidence)) return [...errors, 'Evidence must be an array']
  const required = new Map(matrix.scenarios.flatMap(scenario =>
    scenario.environments.map(environment => [`${environment}/${scenario.id}`,
      matrix.environments.find(host => host.id === environment)?.level])))
  const seen = new Set()
  for (const entry of evidence) {
    const key = `${entry?.environment}/${entry?.scenario}`
    if (!required.has(key)) errors.push(`${key}: unknown scenario/environment`)
    if (seen.has(key)) errors.push(`${key}: duplicate evidence`)
    seen.add(key)
    if (entry?.commit !== commit) errors.push(`${key}: wrong commit`)
    if (entry?.result !== 'passed') errors.push(`${key}: not passed`)
    if (entry?.level !== required.get(key)) errors.push(`${key}: wrong proof level`)
    for (const field of ['osVersion', 'runtimeVersion', 'artifact', 'testedAt']) {
      if (typeof entry?.[field] !== 'string' || !entry[field].trim()) errors.push(`${key}: missing ${field}`)
    }
    if (!Number.isFinite(Date.parse(entry?.testedAt))) errors.push(`${key}: invalid testedAt`)
  }
  for (const key of required.keys()) {
    if (!seen.has(key)) errors.push(`${key}: NOT VERIFIED`)
  }
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const matrix = JSON.parse(readFileSync(new URL('../tests/platform/matrix.json', import.meta.url)))
  const [file, commit] = process.argv.slice(2)
  if (!file || !commit) {
    console.error('Usage: npm run platform:qualify -- evidence.json <40-character-commit-sha>')
    process.exitCode = 1
  } else {
    const errors = qualificationErrors(matrix, JSON.parse(readFileSync(file)), commit)
    console.log(errors.length ? errors.join('\n') : `Platform qualification passed for ${commit}`)
    process.exitCode = errors.length ? 1 : 0
  }
}
