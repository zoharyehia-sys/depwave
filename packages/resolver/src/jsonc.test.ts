import { describe, expect, it } from 'vitest';
import { parseJsonc } from './jsonc.js';

describe('parseJsonc', () => {
  it('strips line and block comments and trailing commas', () => {
    const text = `{
      // line comment
      "a": 1, /* block */
      "b": [1, 2, ],
      "c": { "d": true, },
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2], c: { d: true } });
  });

  it('never touches string contents', () => {
    expect(parseJsonc(`{ "url": "http://x//y", "glob": "src/**/*", "weird": ",}", "esc": "a\\"//b" }`)).toEqual({
      url: 'http://x//y',
      glob: 'src/**/*',
      weird: ',}',
      esc: 'a"//b',
    });
  });

  it('still rejects genuinely invalid JSON', () => {
    expect(() => parseJsonc('{ a: 1 }')).toThrow();
  });
});
