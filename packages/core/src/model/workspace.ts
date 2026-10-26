import type { LanguageId } from './graph.js';

export type WorkspaceTool = 'pnpm' | 'npm' | 'yarn' | 'nx' | 'turbo';

export interface WorkspacePackage {
  name: string;
  /** Repo-relative POSIX path of the package root ('' for the repository root package). */
  root: string;
  /** package.json, or project.json for Nx projects without one. */
  manifestPath: string;
  /** Declared dependency names (all dependency fields + Nx implicitDependencies), sorted. */
  dependencies: string[];
}

export interface Workspace {
  /** Every tool detected; e.g. pnpm + turbo. Empty for a plain single-package repo. */
  tools: WorkspaceTool[];
  /** Sorted by root. */
  packages: WorkspacePackage[];
}

export interface SourceFile {
  path: string;
  language: LanguageId;
  contentHash: string;
  /** Owning package (deepest package root containing the file); absent for files outside every package. */
  packageName?: string;
}

/** Everything analyzable at one revision, built from git state alone (no filesystem walk). */
export interface Inventory {
  rev: string;
  workspace: Workspace;
  /** Source files only, sorted by path. */
  files: SourceFile[];
}
