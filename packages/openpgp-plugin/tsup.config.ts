import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  tsconfig: './tsconfig.build.json',
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
})
