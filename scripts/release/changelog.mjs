#!/usr/bin/env node
// @ts-check
/**
 * Prints one version's section of CHANGELOG.md, for the GitHub release notes.
 *
 * Usage: node scripts/release/changelog.mjs <version>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The body under `## <version>` (anything may follow the version on that line, such as a date), up to the next `## `.
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
  if (body === '') throw new Error(`the "## ${version}" section of CHANGELOG.md is empty`);
  return `${body}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) throw new Error('usage: changelog.mjs <version>');
  process.stdout.write(changelogSection(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'), version));
}
