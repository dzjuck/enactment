import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Vendored third-party rule packs are byte-for-byte upstream, including their rule-test
  // fixtures, which are deliberately vulnerable code. They are scanner input, not our source.
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'fixtures/**',
      'tmp/**',
      'images/reviewer/rule-packs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
