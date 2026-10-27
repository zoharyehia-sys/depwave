import { expect, it } from 'vitest';
import { plugins } from './load';

it('finds plugins', () => {
  expect(Object.keys(plugins)).toContain("./builtin/a.ts");
});
