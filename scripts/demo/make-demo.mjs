#!/usr/bin/env node
// Builds the six-test pnpm monorepo from the README's "See it work" section: @acme/app uses @acme/ui, which uses
// @acme/utils, every import going through a package barrel. Branch `round-prices` changes formatCurrency.
//
//   node scripts/demo/make-demo.mjs [dir]     (default: <tmp>/depwave-demo; an existing dir is replaced)
//   cd <dir> && node <depwave>/packages/cli/dist/bin.js impact --base main
//
// Author and dates are fixed, so the commit hashes, and therefore depwave's output, match the README exactly.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const dir = process.argv[2] ?? join(tmpdir(), 'depwave-demo');
const DATE = '2026-01-01T12:00:00Z';
const env = { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com', GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE };
const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env });
const write = (path, content) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const pkg = (name, deps = {}) => `${JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './src/index.ts', dependencies: deps }, null, 2)}\n`;

rmSync(dir, { recursive: true, force: true });
write('package.json', '{ "name": "acme", "private": true, "devDependencies": { "vitest": "^3.2.3" } }\n');
write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");

write('packages/utils/package.json', pkg('@acme/utils'));
write('packages/utils/src/index.ts', "export { formatCurrency } from './money';\nexport { formatDate } from './dates';\n");
write('packages/utils/src/money.ts', 'export function formatCurrency(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n');
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
git('add', '-A');
git('commit', '-q', '-m', 'initial');

git('checkout', '-q', '-b', 'round-prices');
write('packages/utils/src/money.ts', 'export function formatCurrency(cents: number): string {\n  return `$${Math.round(cents / 100)}`;\n}\n');
git('commit', '-q', '-am', 'round prices to whole dollars');
console.log(`demo monorepo in ${dir}, on branch round-prices:\n${git('log', '--oneline', 'main~0', 'round-prices')}`);
