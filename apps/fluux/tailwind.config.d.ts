// Types for tailwind.config.js, which tests import to compile utilities.
import type { Config } from 'tailwindcss'

export declare const alphaVar: (
  name: string,
) => (options?: { opacityValue?: string; opacityVariable?: string }) => string

declare const config: Config
export default config
