import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import security from 'eslint-plugin-security';

export default [
  // Type-aware rules for src (tsconfig covers these files)
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: './tsconfig.json' },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'security': security,
    },
    rules: {
      '@typescript-eslint/no-deprecated': 'warn',
      ...security.configs.recommended.rules,
      // Too noisy in TypeScript: flags all bracket-notation array/map access (lines[i], arr[idx])
      // which are safe integer-indexed accesses indistinguishable from object injection to the rule.
      'security/detect-object-injection': 'off',
    },
  },
  // Test files: parse without project (no type-aware rules)
  {
    files: ['__tests__/**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'security': security,
    },
    rules: {
      ...security.configs.recommended.rules,
      'security/detect-object-injection': 'off',
    },
  },
];
