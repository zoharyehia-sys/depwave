import type { ChangeStatus, FileChange, Hunk, TrackedFile } from '@depwave/core';

/** Pure parsers for git's machine-readable (`-z`) output. Kept separate from process spawning so they're unit-testable. */

const isZeroOid = (oid: string | undefined): boolean => oid === undefined || /^0+$/.test(oid);

function change(status: ChangeStatus, path: string, oldOid?: string, newOid?: string, oldPath?: string): FileChange {
  const result: FileChange = { status, path };
  if (oldPath !== undefined) result.oldPath = oldPath;
  if (!isZeroOid(oldOid)) result.oldOid = oldOid as string;
  if (!isZeroOid(newOid)) result.newOid = newOid as string;
  return result;
}

/**
 * Parses `git diff --raw -z --no-abbrev [-M]`:
 *   `:<oldMode> <newMode> <oldOid> <newOid> <status>\0<path>\0` and, for R/C, `...\0<oldPath>\0<newPath>\0`.
 * Copies become adds of the new path; type changes and unmerged entries become modifications.
 */
export function parseRawDiff(output: string): FileChange[] {
  const parts = output.split('\0');
  const changes: FileChange[] = [];

  for (let i = 0; i < parts.length; ) {
    const meta = parts[i++];
    if (!meta) continue;
    if (!meta.startsWith(':')) throw new Error(`Unexpected raw diff entry: ${JSON.stringify(meta)}`);

    const [, , oldOid, newOid, status = ''] = meta.slice(1).split(' ');
    // Paths are never empty, so '' (the tail after the final NUL) means the entry was truncated.
    const path = parts[i++];
    if (!path) throw new Error(`Truncated raw diff entry: ${JSON.stringify(meta)}`);

    switch (status[0]) {
      case 'A':
        changes.push(change('A', path, undefined, newOid));
        break;
      case 'D':
        changes.push(change('D', path, oldOid));
        break;
      case 'R':
      case 'C': {
        const to = parts[i++];
        if (!to) throw new Error(`Truncated rename/copy entry: ${JSON.stringify(meta)}`);
        changes.push(status[0] === 'R' ? change('R', to, oldOid, newOid, path) : change('A', to, undefined, newOid));
        break;
      }
      default: // M, T (type change), U (unmerged), X (unknown)
        changes.push(change('M', path, oldOid, newOid));
    }
  }
  return changes;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

/** Extracts hunk ranges from unified diff output. An omitted count means 1. */
export function parseHunks(diff: string): Hunk[] {
  return [...diff.matchAll(HUNK_HEADER)].map(([, oldStart, oldLines, newStart, newLines]) => ({
    oldStart: Number(oldStart),
    oldLines: oldLines === undefined ? 1 : Number(oldLines),
    newStart: Number(newStart),
    newLines: newLines === undefined ? 1 : Number(newLines),
  }));
}

/** Parses `git ls-tree -r -z --full-tree <rev>`: `<mode> <type> <oid>\t<path>`. Submodules (type `commit`) are skipped. */
export function parseLsTree(output: string): TrackedFile[] {
  const files: TrackedFile[] = [];
  for (const entry of output.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [, type, oid] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && oid !== undefined) files.push({ path: entry.slice(tab + 1), oid });
  }
  return files;
}

/** Parses `git ls-files -s -z`: `<mode> <oid> <stage>\t<path>`. Submodules are skipped; conflicted paths appear once. */
export function parseLsFilesStaged(output: string): TrackedFile[] {
  const byPath = new Map<string, string>();
  for (const entry of output.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, oid] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (mode !== '160000' && oid !== undefined && !byPath.has(path)) byPath.set(path, oid);
  }
  return [...byPath].map(([path, oid]) => ({ path, oid }));
}

/**
 * Parses `git cat-file --batch` output for `requested` inputs, in order: `<oid> <type> <size>\n<bytes>\n` per object,
 * or `<input> missing\n`. Sizes are in BYTES, so slicing happens on the Buffer before decoding.
 */
export function parseCatFileBatch(output: Buffer, requested: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  let offset = 0;
  for (const path of requested) {
    const eol = output.indexOf(0x0a, offset);
    if (eol === -1) throw new Error(`Truncated cat-file output at ${JSON.stringify(path)}`);
    const header = output.toString('utf8', offset, eol);
    offset = eol + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) continue;

    const [, type, size] = header.split(' ');
    const bytes = Number(size);
    if (!Number.isInteger(bytes)) throw new Error(`Unexpected cat-file header: ${JSON.stringify(header)}`);
    if (type === 'blob') blobs.set(path, output.toString('utf8', offset, offset + bytes));
    offset += bytes + 1; // content + trailing LF
  }
  return blobs;
}

/** Splits NUL-separated path lists (`ls-files -z`, `diff --name-only -z`). */
export const parsePathList = (output: string): string[] => output.split('\0').filter(Boolean);
