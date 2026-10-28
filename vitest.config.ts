import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packagesDir = fileURLToPath(new URL('./packages', import.meta.url));

export default defineConfig({
  resolve: {
    // Test against sources, not dist: no build step needed before `vitest`.
    alias: [{ find: /^@depwave\/([^/]+)$/, replacement: `${packagesDir}/$1/src/index.ts` }],
  },
  test: {
    // Fixture repos contain their own *.test.ts files; they are data, never run them.
    include: ['packages/*/src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'fixtures/**'],
    // Golden and CLI tests build real git repos and run the pipeline twice (cold, then from cache). They take ~1-2s,
    // but Windows runners occasionally need >5s just to spawn git: the 5s default made CI flaky. A hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
