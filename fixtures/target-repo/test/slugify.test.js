import { describe, expect, it } from 'vitest';

import { slugify } from '../src/slugify.js';

describe('slugify', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('drops punctuation', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('collapses and trims separators', () => {
    expect(slugify('  Hello   ---   World  ')).toBe('hello-world');
  });
});
