import type { GlobalTrigger, ImpactReport } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { MarkdownReporter } from './MarkdownReporter.js';
import { TextReporter } from './TextReporter.js';
import { groupTriggers, listPaths } from './triggers.js';

const data = (path: string, scope = 'pkg:root'): GlobalTrigger => ({ kind: 'data-file', path, scope: [scope] });

describe('trigger grouping (regression: 18 changed fixture files produced 18 notes in a PR comment)', () => {
  it('groups by kind and scope, keeping first-seen order', () => {
    const groups = groupTriggers([data('f/a.json'), { kind: 'lockfile', path: 'pnpm-lock.yaml' }, data('f/b.json'), data('x/c.json', 'pkg:x'), data('f/a.json')]);
    expect(groups.map((g) => [g.sample.kind, g.paths])).toEqual([
      ['data-file', ['f/a.json', 'f/b.json']],
      ['lockfile', ['pnpm-lock.yaml']],
      ['data-file', ['x/c.json']],
    ]);
  });

  it('lists a few names and counts the rest', () => {
    expect(listPaths(['a'])).toBe('a');
    expect(listPaths(['a', 'b'])).toBe('a and b');
    expect(listPaths(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listPaths(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    expect(listPaths(['a', 'b'], 3, (p) => `\`${p}\``)).toBe('`a` and `b`');
  });

  it('renders one note / one line per group in both reporters', () => {
    const report: ImpactReport = {
      base: 'b',
      head: 'h',
      granularity: 'symbol',
      changedFiles: [],
      seeds: [],
      globalTriggers: Array.from({ length: 18 }, (_, i) => data(`fixtures/f${i}.json`)),
      impacted: [],
      unresolved: [],
    };
    const plan = { runAll: false, groups: [], totalTests: 10 };
    const md = new MarkdownReporter().render(report, plan);
    expect(md.match(/\[!NOTE\]/g)).toHaveLength(1);
    expect(md).toContain('> `fixtures/f0.json`, `fixtures/f1.json`, `fixtures/f2.json` and 15 more changed (data-file):');
    const text = new TextReporter().render(report, plan);
    expect(text.match(/trigger:/g)).toHaveLength(1);
    expect(text).toContain('trigger:        fixtures/f0.json, fixtures/f1.json, fixtures/f2.json and 15 more (data-file)');
  });
});
