import { parseSync, transformFromAstSync, traverse } from '@babel/core'
import compiler from 'babel-plugin-react-compiler'
import { reactCompilerOptions } from './reactCompilerOptions.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const hotComponents = {
  'components/conversation/MessageList.tsx': ['MessageList'],
  'components/conversation/MessageBubble.tsx': ['MessageBubble'],
  'components/conversation/ConversationThread.tsx': ['ConversationThread'],
  'hooks/useConversationThread.ts': ['useConversationThread'],
  'components/ChatView.tsx': ['ChatView'],
  'components/RoomView.tsx': ['RoomView', 'RoomMessageList'],
  'components/MessageComposer.tsx': ['MessageComposer'],
  'components/sidebar-components/ContactList.tsx': ['ContactList'],
  'components/sidebar-components/ConversationList.tsx': ['ConversationList'],
  'components/sidebar-components/RoomsList.tsx': ['RoomsList'],
}

// Shared build options keep this lint aligned. The logger observes the actual
// transform, including unsupported syntax that the ESLint rules cannot report.
export function analyze(source, filename) {
  const events = []
  const options = {
    filename, configFile: false, babelrc: false,
    parserOpts: { plugins: ['typescript', ...(filename.includes('.tsx') ? ['jsx'] : [])] },
  }
  const ast = parseSync(source, options)
  const names = new Map()
  traverse(ast, {
    Function(path) {
      const name = path.node.id?.name ?? (path.parent.type === 'VariableDeclarator' ? path.parent.id.name : undefined)
      if (name) names.set(path.node.start, name)
    },
  })
  transformFromAstSync(ast, source, {
    ...options,
    plugins: [[compiler, { ...reactCompilerOptions, logger: { logEvent(_filename, event) { events.push(event) } } }]],
  })
  return events.map(event => ({ ...event, fnName: event.fnName ?? names.get(event.fnLoc?.start.index) }))
}

function* sources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) yield path
  }
}

export function checkFiles(files, required = hotComponents, write = console.log) {
  const compiled = new Map()
  let skipped = 0
  for (const filename of files) {
    const path = relative(join(app, 'src'), filename).replaceAll('\\', '/')
    const events = analyze(readFileSync(filename, 'utf8'), filename)
    for (const event of events) {
      if (event.kind === 'PipelineError') {
        throw new Error(`${path}: React Compiler pipeline failed: ${event.data}`)
      }
      if (event.kind === 'CompileSuccess') {
        compiled.set(`${path}:${event.fnName}`, event)
      } else if (event.kind === 'CompileError' || event.kind === 'CompileSkip') {
        skipped++
        const detail = event.detail?.options
        const location = detail?.loc ?? detail?.details?.find(item => item.loc)?.loc ?? event.loc ?? event.fnLoc
        const name = event.fnName ?? `function at line ${event.fnLoc?.start.line ?? 1}`
        const explanation = detail?.description ? ` — ${detail.description}` : ''
        write(`${path}:${location?.start.line ?? 1}: warning: ${name}: ${detail?.reason ?? event.reason ?? event.kind}${explanation}`)
      }
    }
  }
  const missing = Object.entries(required).flatMap(([path, names]) => names
    .filter(name => !compiled.has(`${path}:${name}`)).map(name => `${path}:${name}`))
  for (const [path, names] of Object.entries(required)) {
    for (const name of names) {
      const event = compiled.get(`${path}:${name}`)
      if (event) write(`compiled: ${path}:${name} (${event.memoSlots} memo slots)`)
    }
  }
  for (const name of missing) write(`error: React Compiler did not compile ${name}`)
  write(`React Compiler: ${compiled.size} compiled functions, ${skipped} skip diagnostics, ${missing.length} required components missing`)
  return { compiled, missing, skipped, exitCode: missing.length ? 1 : 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkFiles([...sources(join(app, 'src'))])
  process.exitCode = result.exitCode
}
