// @farm/eslint-config — flat ESLint config. Two lint-enforced seam rules on core/ui:
//  1. no-restricted-imports: core/ui may not import a concrete adapter-* (the seam is
//     @farm/adapter-api; only apps/console registers adapters).
//  2. no-restricted-syntax: core/ui may not READ `.raw` — a `.raw` access is the
//     build-failing signal to promote that field into a typed capability member.
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['packages/core/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
  languageOptions: { parser: tseslint.parser },
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@farm/adapter-*', '!@farm/adapter-api'],
            message:
              'core/ui may not import a concrete adapter-* — the seam is @farm/adapter-api; only apps/console registers adapters.',
          },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: "MemberExpression[property.name='raw']",
        message:
          'core/ui may not read `.raw` — promote the field to a typed member (seam .raw lint-ban).',
      },
    ],
  },
});
