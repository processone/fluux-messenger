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
