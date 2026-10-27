import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('ships a template', () => {
  const config = JSON.parse(readFileSync(new URL('../templates/config.json', import.meta.url), 'utf8'));
  expect(config.files).toContain('index.html');
});
