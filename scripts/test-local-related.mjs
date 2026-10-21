// Vitest's CLI list command does not accept --related. Use its public Node API
// for discovery only, then let the regular workspace CLI run the selected suite.
import { createVitest } from 'vitest/node'

const [workspace, ...sources] = process.argv.slice(2)
if (!workspace || !sources.length) throw new Error('Expected a workspace and absolute source paths')
const context = await createVitest({ root: workspace, related: sources, watch: false, run: true })
try {
  const specifications = await context.getRelevantTestSpecifications()
  console.log(JSON.stringify([...new Set(specifications.map(specification => specification.moduleId))]))
} finally {
  await context.close()
}
