import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow unused vars/args prefixed with underscore
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  // The interop runner is standalone operational tooling (a Node script + Python + shell),
  // not shipped library source — excluded from the TypeScript lint pass.
  { ignores: ['dist/**', 'src/interop/venv/**'] },
)
