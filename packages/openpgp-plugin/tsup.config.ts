import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', web: 'src/web.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  tsconfig: './tsconfig.build.json',
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
})
