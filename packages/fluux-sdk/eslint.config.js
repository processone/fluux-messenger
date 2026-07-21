import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused vars prefixed with underscore
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Warn on explicit any in production code
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow non-null assertions (we use them carefully in tests)
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Prefer const
      'prefer-const': 'error',
      // Allow console - SDK needs logging for debugging and error reporting
      'no-console': 'off',
      // The stores barrel is for consumers only. Internal modules must import the
      // concrete store file, otherwise stores/index.ts lands back in an import cycle
      // with core/ and Rollup emits "reexported through ... circular dependency
      // between chunks" warnings when it bundles the type declarations.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Only the barrel itself ('./stores', '../stores', '../../stores'),
              // never the concrete modules underneath it ('../stores/chatStore').
              regex: '^(\\.{1,2}/)+stores$',
              message:
                "Import the concrete store module (e.g. '../stores/chatStore') instead of the '../stores' barrel - the barrel is the public entry point and re-exporting through it creates an import cycle with core/.",
            },
          ],
        },
      ],
    },
  },
  {
    // The root public entry point legitimately re-exports the stores barrel.
    files: ['src/index.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Relaxed rules for test files
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test-utils.ts'],
    rules: {
      // Allow generic Function type in test mocks
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // Allow any in tests for mocking flexibility
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests may use the public barrel - they are not part of the build graph
      // and resolve to the same store singletons either way.
      'no-restricted-imports': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.js'],
  }
)
