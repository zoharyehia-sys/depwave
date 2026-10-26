import type { LanguageId } from './graph.js';

export interface WorkspacePackage {
  name: string;
  /** Repo-relative POSIX path of the package root ('' for single-package repos). */
  root: string;
  manifestPath: string;
  /** Declared dependency names (dependencies + devDependencies + peerDependencies). */
  dependencies: string[];
}

export interface Workspace {
  /** Absolute path of the repository root. */
  rootDir: string;
  tool: 'pnpm' | 'npm' | 'yarn' | 'nx' | 'none';
  packages: WorkspacePackage[];
}

export interface SourceFile {
  path: string;
  language: LanguageId;
  contentHash: string;
  packageName?: string;
}
