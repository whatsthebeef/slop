import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', 'catalog/**', '**/drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    // The core is framework-free: it may import only itself and plain libraries listed here.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.{1,2}/|zod$|node:crypto$)',
              message:
                'packages/core must stay framework-free: import ports, not adapters or frameworks.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.{js,mjs}', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
