import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    // Main bundle (full SDK with React)
    index: 'src/index.ts',
    // React-only bundle (provider, hooks)
    'react/index': 'src/react/index.ts',
    // Core-only bundle (XMPPClient, types - for bots/CLI)
    'core/index': 'src/core/index.ts',
    // Stores bundle (direct Zustand access)
    'stores/index': 'src/stores/index.ts',
    // Demo bundle (dev-only DemoClient + seed helpers)
    'demo/index': 'src/demo/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: {
    compilerOptions: {
      // Use build config that excludes test files
    }
  },
  tsconfig: './tsconfig.build.json',
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['react', 'zustand', 'xstate', '@xstate/react'],
  treeshake: true,
  minify: false,
  esbuildOptions(options) {
    options.jsx = 'automatic'
  },
})
