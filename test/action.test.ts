/**
 * The GitHub Action's pure parts. The network calls are exercised for real by the dogfood workflow on every PR.
 */
import { COMMENT_MARKER } from '@depwave/reporters';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { findStickyComment, fitBody, MARKER, MAX_BODY } from '../action/post-comment.mjs';

describe('post-comment', () => {
  it('uses the same marker the Markdown reporter writes', () => {
    expect(MARKER).toBe(COMMENT_MARKER);
  });

  it('updates the most recent depwave comment and ignores everyone else', () => {
    const comments = [
      { id: 1, body: `${MARKER}\nold report` },
      { id: 2, body: 'LGTM' },
      { id: 3, body: null },
      { id: 4, body: `${MARKER}\nnewer report` },
      { id: 5, body: 'quoting depwave: impacted' },
    ];
    expect(findStickyComment(comments)).toMatchObject({ id: 4 });
    expect(findStickyComment([{ id: 9, body: 'no marker here' }])).toBeUndefined();
  });

  it('leaves normal bodies alone and cuts oversized ones at a line boundary, with a note', () => {
    expect(fitBody('short')).toBe('short');
    const huge = Array.from({ length: 5000 }, (_, i) => `- \`packages/p${i}/src/a.test.ts\``).join('\n');
    const fitted = fitBody(huge);
    expect(huge.length).toBeGreaterThan(MAX_BODY);
    expect(fitted.length).toBeLessThanOrEqual(MAX_BODY);
    expect(fitted).toMatch(/\.test\.ts`\n\n> \[!NOTE\]\n> Report truncated/);
  });
});

describe('YAML files GitHub reads', () => {
  // GitHub only reports a malformed action/workflow when a run starts. Parse them here so CI fails first.
  const files = ['../action.yml', ...readdirSync(new URL('../.github/workflows/', import.meta.url)).map((f) => `../.github/workflows/${f}`)];

  it.each(files)('%s parses as YAML with no errors', (file) => {
    const doc = parseDocument(readFileSync(new URL(file, import.meta.url), 'utf8'));
    expect(doc.errors.map((e) => e.message)).toEqual([]);
    expect(doc.toJS()).toBeTypeOf('object');
  });

  it('action.yml declares every input it reads and every output it promises', () => {
    const action = parseDocument(readFileSync(new URL('../action.yml', import.meta.url), 'utf8')).toJS() as {
      inputs: Record<string, unknown>;
      outputs: Record<string, { value: string }>;
      runs: { using: string };
    };
    expect(action.runs.using).toBe('composite');
    expect(Object.keys(action.inputs).sort()).toEqual(['base', 'comment', 'explain', 'github-token', 'granularity']);
    for (const [name, output] of Object.entries(action.outputs)) expect(output.value, name).toBe(`\${{ steps.analyze.outputs.${name} }}`);
  });
});

describe('action.yml', () => {
  const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');

  it('runs the built CLI with markdown output and posts it through post-comment.mjs', () => {
    expect(action).toContain('--format markdown --explain "$INPUT_EXPLAIN"');
    expect(action).toContain('node "$GITHUB_ACTION_PATH/action/post-comment.mjs" "$REPORT_MD"');
  });

  it('never interpolates ${{ }} expressions straight into a shell script', () => {
    const runBlocks = [...action.matchAll(/run: \|?([\s\S]*?)(?=\n {4}- |\n*$)/g)].map((m) => m[1] ?? '');
    expect(runBlocks).toHaveLength(3); // build, analyze, comment: guards against a regex that matches nothing
    for (const block of runBlocks) expect(block).not.toMatch(/\$\{\{/);
    expect(runBlocks.join('\n')).not.toContain('steps.analyze.outputs'); // outputs reach scripts via env only
  });
});
