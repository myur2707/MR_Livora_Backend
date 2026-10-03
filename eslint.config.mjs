import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', '.local-db/**', '.local-tools/**'] },
  js.configs.recommended,
  {
    files: ['.github/scripts/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
  tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  { files: ['src/**/*.ts'], rules: { complexity: ['error', 30] } },
);
