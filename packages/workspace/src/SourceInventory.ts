import {
  languageFromPath,
  type GitPort,
  type Inventory,
  type InventoryPort,
  type LanguageId,
  type Revision,
  type SourceFile,
  type WorkspacePort,
} from '@depwave/core';
import { createIgnoreMatcher, loadConfig } from './config.js';
import { createOwnerLookup } from './paths.js';

/**
 * Maps every source file at a revision to its language, content hash and owning package.
 * Cost: one `git ls-tree`/`ls-files` listing plus one batched manifest read. No per-file I/O, no filesystem walk.
 * Paths matching `depwave.config.json` `ignore` globs are invisible from here on: no packages, files or glob matches.
 */
export class SourceInventory implements InventoryPort {
  constructor(
    private readonly git: GitPort,
    private readonly discovery: WorkspacePort,
    private readonly detectLanguage: (path: string) => LanguageId | undefined = languageFromPath,
  ) {}

  async inventory(rev: Revision): Promise<Inventory> {
    const listed = await this.git.listTracked(rev);
    const isIgnored = createIgnoreMatcher(await loadConfig(this.git, rev, new Set(listed.map((f) => f.path))));
    const tracked = listed.filter((f) => !isIgnored(f.path));
    const workspace = await this.discovery.discover(rev, tracked);
    const ownerOf = createOwnerLookup(workspace.packages);

    const files: SourceFile[] = [];
    for (const { path, oid } of tracked) {
      const language = this.detectLanguage(path);
      // Committed node_modules is vendored code: never part of the graph.
      if (language === undefined || path.split('/').includes('node_modules')) continue;
      const file: SourceFile = { path, language, contentHash: oid };
      const owner = ownerOf(path);
      if (owner) file.packageName = owner.name;
      files.push(file);
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { rev, workspace, files, paths: tracked.map((f) => f.path) };
  }
}
