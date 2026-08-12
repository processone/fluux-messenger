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
    // The whole app is migrated and `utils/tauri` is gone; this keeps it gone.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    // Detection itself lives in src/platform; its own module must probe.
    ignores: ['src/platform/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Any path landing on a re-created utils/tauri. Deliberately not
              // a bare `tauri$`: `anomaly/sinks/tauri.ts` is a log sink, not a
              // platform probe. Never matches '@tauri-apps/*' either.
              regex: '(^|/)utils/tauri$',
              message:
                "Branch on a named capability from '@/platform' (e.g. platform().nativeKeychain) rather than on isTauri() - the platform is not binary, and the capability name is what tells the next reader why this code differs per host.",
            },
          ],
        },
      ],

      // The import rule alone would not have stopped what actually happened:
      // ten modules grew their own `'__TAURI_INTERNALS__' in window` rather
      // than importing anything. Detection belongs in `src/platform` and
      // nowhere else, so the probe itself is what is banned.
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value='__TAURI_INTERNALS__']",
          message:
            "Detect the platform once, in 'src/platform'. Read a named capability from platform() here instead of probing the global - a local probe answers 'is this Tauri', which is not the question any call site actually has.",
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
