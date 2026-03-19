import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactCompiler from 'eslint-plugin-react-compiler'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-compiler': reactCompiler,
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
      'react-compiler/react-compiler': 'warn',

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
