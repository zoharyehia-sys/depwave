import { describe, expect, it } from 'vitest';
import { parseCatFileBatch, parseHunks, parseLsFilesStaged, parseLsTree, parsePathList, parseRawDiff } from './parse.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const raw = (...entries: string[][]) => `${entries.map((e) => e.join('\0')).join('\0')}\0`;

describe('parseRawDiff', () => {
  it('parses add, modify and delete with oids', () => {
    const output = raw(
      [`:000000 100644 ${ZERO} ${NEW} A`, 'src/new.ts'],
      [`:100644 100644 ${OLD} ${NEW} M`, 'src/mod.ts'],
      [`:100644 000000 ${OLD} ${ZERO} D`, 'src/gone.ts'],
    );
    expect(parseRawDiff(output)).toEqual([
      { status: 'A', path: 'src/new.ts', newOid: NEW },
      { status: 'M', path: 'src/mod.ts', oldOid: OLD, newOid: NEW },
      { status: 'D', path: 'src/gone.ts', oldOid: OLD },
    ]);
  });

  it('parses renames (with similarity score) into new path + oldPath', () => {
    expect(parseRawDiff(raw([`:100644 100644 ${OLD} ${NEW} R087`, 'src/old.ts', 'src/new.ts']))).toEqual([
      { status: 'R', path: 'src/new.ts', oldPath: 'src/old.ts', oldOid: OLD, newOid: NEW },
    ]);
  });

  it('treats copies as adds and type changes / unmerged as modifications', () => {
    const output = raw(
      [`:100644 100644 ${OLD} ${NEW} C075`, 'src/a.ts', 'src/a-copy.ts'],
      [`:100644 120000 ${OLD} ${NEW} T`, 'src/link.ts'],
      [`:000000 000000 ${ZERO} ${ZERO} U`, 'src/conflict.ts'],
    );
    expect(parseRawDiff(output)).toEqual([
      { status: 'A', path: 'src/a-copy.ts', newOid: NEW },
      { status: 'M', path: 'src/link.ts', oldOid: OLD, newOid: NEW },
      { status: 'M', path: 'src/conflict.ts' },
    ]);
  });

  it('omits the zero oid git reports for unhashed working-tree files', () => {
    expect(parseRawDiff(raw([`:100644 100644 ${OLD} ${ZERO} M`, 'src/dirty.ts']))).toEqual([
      { status: 'M', path: 'src/dirty.ts', oldOid: OLD },
    ]);
  });

  it('keeps unusual paths verbatim (spaces, tabs, unicode)', () => {
    const paths = ['src/with space.ts', 'src/tab\there.ts', 'src/שלום.ts'];
    const output = raw(...paths.map((p) => [`:100644 100644 ${OLD} ${NEW} M`, p]));
    expect(parseRawDiff(output).map((c) => c.path)).toEqual(paths);
  });

  it('returns nothing for empty output and rejects garbage', () => {
    expect(parseRawDiff('')).toEqual([]);
    expect(() => parseRawDiff('not a raw line\0')).toThrow(/Unexpected raw diff entry/);
    expect(() => parseRawDiff(`:100644 100644 ${OLD} ${NEW} R100\0only-old.ts\0`)).toThrow(/Truncated/);
  });
});

describe('parseHunks', () => {
  it('parses headers, defaulting omitted counts to 1', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -3 +3 @@ export function f() {',
      '-old',
      '+new',
      '@@ -7,0 +8,2 @@',
      '+added 1',
      '+added 2',
      '@@ -20,3 +21,0 @@',
      '-gone',
    ].join('\n');
    expect(parseHunks(diff)).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
      { oldStart: 7, oldLines: 0, newStart: 8, newLines: 2 },
      { oldStart: 20, oldLines: 3, newStart: 21, newLines: 0 },
    ]);
  });

  it('returns no hunks for empty or binary diffs', () => {
    expect(parseHunks('')).toEqual([]);
    expect(parseHunks('Binary files a/x.png and b/x.png differ\n')).toEqual([]);
  });
});

describe('parseLsTree', () => {
  it('keeps blobs and skips submodules', () => {
    const output = [`100644 blob ${OLD}\tsrc/a.ts`, `160000 commit ${NEW}\tvendor/sub`, `120000 blob ${NEW}\tlink`, ''].join('\0');
    expect(parseLsTree(output)).toEqual([
      { path: 'src/a.ts', oid: OLD },
      { path: 'link', oid: NEW },
    ]);
  });
});

describe('parseLsFilesStaged', () => {
  it('keeps one entry per path and skips submodules', () => {
    const output = [
      `100644 ${OLD} 0\tsrc/a.ts`,
      `100644 ${OLD} 1\tsrc/conflict.ts`,
      `100644 ${NEW} 2\tsrc/conflict.ts`,
      `160000 ${NEW} 0\tvendor/sub`,
      '',
    ].join('\0');
    expect(parseLsFilesStaged(output)).toEqual([
      { path: 'src/a.ts', oid: OLD },
      { path: 'src/conflict.ts', oid: OLD },
    ]);
  });
});

describe('parseCatFileBatch', () => {
  it('slices by byte size, skips missing objects and non-blobs', () => {
    const hebrew = 'שלום\nעולם'; // 2-byte chars: size in bytes ≠ string length
    const output = Buffer.concat([
      Buffer.from(`${OLD} blob ${Buffer.byteLength(hebrew)}\n${hebrew}\n`),
      Buffer.from('HEAD:nope.ts missing\n'),
      Buffer.from(`${NEW} tree 3\nxyz\n`),
      Buffer.from(`${NEW} blob 0\n\n`),
    ]);
    expect(parseCatFileBatch(output, ['he.ts', 'nope.ts', 'dir', 'empty.ts'])).toEqual(
      new Map([
        ['he.ts', hebrew],
        ['empty.ts', ''],
      ]),
    );
  });

  it('rejects truncated output', () => {
    expect(() => parseCatFileBatch(Buffer.from(''), ['a.ts'])).toThrow(/Truncated/);
  });
});

describe('parsePathList', () => {
  it('splits on NUL and drops the trailing empty entry', () => {
    expect(parsePathList('a.ts\0b c.ts\0')).toEqual(['a.ts', 'b c.ts']);
    expect(parsePathList('')).toEqual([]);
  });
});
