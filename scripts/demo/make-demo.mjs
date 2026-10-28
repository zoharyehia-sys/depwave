#!/usr/bin/env node
// @ts-check
/**
 * Builds the six-test `@acme` pnpm monorepo behind the README's "See it work" and shadow-mode examples:
 * `@acme/app` → `@acme/ui` → `@acme/utils`, every import through a `src/index.ts` barrel, and a `round-prices` branch
 * (checked out) that changes `formatCurrency`. Also writes `results.json`, a Vitest JSON report of a full run in which
 * `profile.test.ts` failed, for `depwave shadow`.
 *
 * Usage: node scripts/demo/make-demo.mjs <dir>
 * Commit dates are pinned, so the commit SHAs match the README unless your git config signs commits.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/demo/make-demo.mjs <dir>');
  process.exit(1);
}
// The directory is wiped first, so only ever wipe an earlier demo.
if (existsSync(dir) && readdirSync(dir).length > 0) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, 'utf8')).name !== 'acme') {
    console.error(`${dir} is not empty and is not an earlier demo; pick another directory`);
    process.exit(1);
  }
}
rmSync(dir, { recursive: true, force: true });

const write = (/** @type {string} */ path, /** @type {string} */ content) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const env = { ...process.env, GIT_AUTHOR_DATE: '2026-10-28T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-28T12:00:00Z' };
const git = (/** @type {string[]} */ ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
const pkg = (/** @type {string} */ name, deps = {}) =>
  `${JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './src/index.ts', dependencies: deps }, null, 2)}\n`;

write('package.json', '{ "name": "acme", "private": true, "devDependencies": { "vitest": "^3.2.3" } }\n');
write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");

write('packages/utils/package.json', pkg('@acme/utils'));
write('packages/utils/src/index.ts', "export { formatCurrency } from './money';\nexport { formatDate } from './dates';\n");
write('packages/utils/src/money.ts', "export function formatCurrency(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n");
write('packages/utils/src/dates.ts', 'export function formatDate(date: Date): string {\n  return date.toISOString().slice(0, 10);\n}\n');
write('packages/utils/src/money.test.ts', "import { formatCurrency } from './money';\n\ntest('formats cents', () => expect(formatCurrency(1999)).toBe('$19.99'));\n");
write('packages/utils/src/dates.test.ts', "import { formatDate } from './dates';\n\ntest('formats dates', () => expect(formatDate(new Date(0))).toBe('1970-01-01'));\n");

write('packages/ui/package.json', pkg('@acme/ui', { '@acme/utils': 'workspace:*' }));
write('packages/ui/src/index.ts', "export { PriceTag } from './PriceTag';\nexport { DateLabel } from './DateLabel';\n");
write('packages/ui/src/PriceTag.ts', "import { formatCurrency } from '@acme/utils';\n\nexport function PriceTag(cents: number): string {\n  return `<span class=\"price\">${formatCurrency(cents)}</span>`;\n}\n");
write('packages/ui/src/DateLabel.ts', "import { formatDate } from '@acme/utils';\n\nexport function DateLabel(date: Date): string {\n  return `<time>${formatDate(date)}</time>`;\n}\n");
write('packages/ui/src/PriceTag.test.ts', "import { PriceTag } from './PriceTag';\n\ntest('renders a price', () => expect(PriceTag(500)).toContain('$5.00'));\n");
write('packages/ui/src/DateLabel.test.ts', "import { DateLabel } from './DateLabel';\n\ntest('renders a date', () => expect(DateLabel(new Date(0))).toContain('1970'));\n");

write('packages/app/package.json', pkg('@acme/app', { '@acme/ui': 'workspace:*' }));
write('packages/app/src/index.ts', "export { renderCheckout } from './checkout';\nexport { renderProfile } from './profile';\n");
write('packages/app/src/checkout.ts', "import { PriceTag } from '@acme/ui';\n\nexport function renderCheckout(total: number): string {\n  return `Total: ${PriceTag(total)}`;\n}\n");
write('packages/app/src/profile.ts', "import { DateLabel } from '@acme/ui';\n\nexport function renderProfile(joined: Date): string {\n  return `Member since ${DateLabel(joined)}`;\n}\n");
write('packages/app/src/checkout.test.ts', "import { renderCheckout } from './checkout';\n\ntest('shows the total', () => expect(renderCheckout(1999)).toContain('$19.99'));\n");
write('packages/app/src/profile.test.ts', "import { renderProfile } from './profile';\n\ntest('shows the join date', () => expect(renderProfile(new Date(0))).toContain('1970'));\n");

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Demo');
git('config', 'user.email', 'demo@example.com');
git('config', 'core.autocrlf', 'false');
git('add', '-A');
git('commit', '-q', '-m', 'initial');

git('checkout', '-q', '-b', 'round-prices');
write('packages/utils/src/money.ts', "export function formatCurrency(cents: number): string {\n  return `$${Math.round(cents / 100)}`;\n}\n");
git('commit', '-q', '-am', 'round prices to whole dollars');

// A full run on the branch, with one failure that a selective run would have skipped. Paths are relative to the
// repository root, which `depwave shadow` accepts; Vitest itself writes absolute paths.
const tests = ['utils/src/money', 'utils/src/dates', 'ui/src/PriceTag', 'ui/src/DateLabel', 'app/src/checkout', 'app/src/profile'];
const testResults = tests.map((t) => {
  const status = t === 'app/src/profile' ? 'failed' : 'passed';
  return { name: `packages/${t}.test.ts`, status, assertionResults: [{ status }] };
});
write('results.json', `${JSON.stringify({ testResults }, null, 2)}\n`);
write('.git/info/exclude', 'results.json\n');

console.log(git('log', '--oneline', '--all'));
