import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { changelogSection } from '../scripts/release/changelog.mjs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('release notes', () => {
  const changelog = '# Changelog\n\nIntro.\n\n## 1.1.0 (2026-12-01)\n\n- **New:** b\n\n## 1.0.0\r\n\r\n- a\r\n';

  it('takes one version section, whatever follows the version on its heading', () => {
    expect(changelogSection(changelog, '1.1.0')).toBe('- **New:** b\n');
    expect(changelogSection(changelog, '1.0.0')).toBe('- a\n');
  });

  it('never matches a longer version that starts the same, and fails on a missing or empty section', () => {
    expect(() => changelogSection('## 1.0.0-alpha.1\n\n- x\n', '1.0.0')).toThrow('CHANGELOG.md has no "## 1.0.0" section');
    expect(() => changelogSection('## 1.0.0\n\n## 0.9.0\n- y\n', '1.0.0')).toThrow('is empty');
  });

  it('has a changelog section for the version about to ship', () => {
    const { version } = JSON.parse(read('../packages/cli/package.json')) as { version: string };
    expect(changelogSection(read('../CHANGELOG.md'), version)).not.toBe('');
  });
});
