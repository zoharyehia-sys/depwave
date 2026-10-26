import { expect, it } from 'vitest';
import { routes } from './routes';

it('lazy-loads home', async () => {
  expect((await routes.home()).Home()).toContain('Home');
});
