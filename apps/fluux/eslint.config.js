import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactCompiler from 'eslint-plugin-react-compiler'
import react from 'eslint-plugin-react'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-compiler': reactCompiler,
      react,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // React hooks rules
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // React Compiler
      'react-compiler/react-compiler': 'warn',

      // A <button> with no type attribute defaults to type="submit". Inside a
      // <form> that silently triggers the form's onSubmit - which is how the
      // backup dialog's Copy button ended up publishing the OpenPGP key.
      // Only this rule is enabled from eslint-plugin-react; the recommended
      // preset is deliberately not used here.
      // eslint-plugin-react 7.37.5 still caps its eslint peer at ^9.7, so the
      // root package.json overrides that peer to ^10 - the rule itself runs
      // fine on eslint 10. Drop the override once upstream supports it.
      'react/button-has-type': 'error',

      // Allow unused vars prefixed with underscore
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Allow explicit any - sometimes needed for third-party libs
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow non-null assertions
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Catch floating promises (unhandled async) - warn for now, fix incrementally
      '@typescript-eslint/no-floating-promises': 'warn',
      // Prefer const
      'prefer-const': 'error',
      // Allow console - useful for debugging during development
      'no-console': 'off',
    },
  },
  {
    // `isTauri()` reads as one question but answers at least six, and the real
    // answers already diverge: in-app updates are desktop-except-Linux, the tray
    // preference is desktop-on-Windows-and-Linux, taskbar attention is
    // desktop-on-Windows-only. Branch on a named capability from '@/platform'
    // instead, so a call site says WHY it branches and a new target can be
    // described rather than guessed at.
    //
    // Scoped to the layers that have been migrated. `hooks/` is the last one
    // left; widen this when it follows, and do not add exceptions.
    files: ['src/utils/**/*.ts', 'src/components/**/*.ts', 'src/components/**/*.tsx', 'src/App.tsx'],
    // `tauri.ts` owns the remaining probes; its own test has to import them.
    ignores: ['src/utils/tauri.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Any path landing on utils/tauri: './tauri', './utils/tauri',
              // '../utils/tauri', '@/utils/tauri'. Never '@tauri-apps/*', and
              // never '@/utils/tauriPlatform'.
              regex: '(^|/)tauri$',
              message:
                "Branch on a named capability from '@/platform' (e.g. platform().nativeKeychain) rather than on isTauri() - the platform is not binary, and the capability name is what tells the next reader why this code differs per host.",
            },
          ],
        },
      ],
    },
  },
  {
    // Relaxed rules for test files
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', '*.js'],
  }
)
