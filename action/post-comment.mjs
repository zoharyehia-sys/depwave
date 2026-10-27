#!/usr/bin/env node
// @ts-check
/**
 * Posts depwave's Markdown report as ONE sticky pull-request comment: the first run creates it, later runs edit it in
 * place (found by a hidden marker), so a PR with 20 pushes still has a single depwave comment.
 *
 * Usage (inside GitHub Actions): GITHUB_TOKEN=… node post-comment.mjs <report.md>
 * No dependencies: Node's built-in fetch against the REST API.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- depwave-impact -->';
/** GitHub rejects comment bodies over 65,536 characters. */
export const MAX_BODY = 65_000;

/**
 * The comment to update: the most recent one carrying the marker.
 * @param {ReadonlyArray<{ id: number; body?: string | null }>} comments
 * @returns {{ id: number } | undefined}
 */
export function findStickyComment(comments, marker = MARKER) {
  return [...comments].reverse().find((c) => typeof c.body === 'string' && c.body.includes(marker));
}

/**
 * Keeps the body under GitHub's limit, cutting at a line boundary and saying so.
 * @param {string} body
 */
export function fitBody(body, max = MAX_BODY) {
  if (body.length <= max) return body;
  const note = '\n\n> [!NOTE]\n> Report truncated to fit GitHub\'s comment limit. The full report is in the job summary.\n';
  const cut = body.lastIndexOf('\n', max - note.length);
  return body.slice(0, cut > 0 ? cut : max - note.length) + note;
}

async function main() {
  const [file] = process.argv.slice(2);
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_EVENT_PATH: eventPath } = process.env;
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  if (!file || !token || !repo || !eventPath) throw new Error('usage: GITHUB_TOKEN=… node post-comment.mjs <report.md> (inside GitHub Actions)');

  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const pr = event.pull_request?.number;
  if (!pr) {
    console.log('depwave: not a pull_request event; skipping the comment.');
    return;
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const comments = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`listing comments failed: HTTP ${response.status}`);
    const batch = await response.json();
    comments.push(...batch);
    if (batch.length < 100) break;
  }

  const body = fitBody(readFileSync(file, 'utf8'));
  const existing = findStickyComment(comments);
  const response = existing
    ? await fetch(`${api}/repos/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) })
    : await fetch(`${api}/repos/${repo}/issues/${pr}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });

  if (response.status === 403 || response.status === 404) {
    // Fork PRs get a read-only token: report in the job summary instead of failing the PR.
    console.log(`::warning::depwave could not comment on PR #${pr} (HTTP ${response.status}, read-only token?). The report is in the job summary.`);
    return;
  }
  if (!response.ok) throw new Error(`${existing ? 'updating' : 'creating'} the comment failed: HTTP ${response.status}`);
  const { html_url: url } = await response.json();
  console.log(`depwave: ${existing ? 'updated' : 'posted'} ${url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`depwave: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
