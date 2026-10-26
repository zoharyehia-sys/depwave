import type { UnresolvedReason } from '../model/graph.js';

export type ResolutionResult = (
  | { kind: 'file'; path: string }
  | { kind: 'external'; packageName: string; specifier: string }
  | { kind: 'unresolved'; reason: UnresolvedReason }
) & {
  /**
   * Every path the resolver checked, including ones that did NOT exist.
   * Adding a file at a probed path can change the result even though the importer didn't change
   * (e.g. adding `utils.ts` next to `utils/index.ts`), so the cache invalidates on these.
   */
  probed: readonly string[];
};

export interface ResolverPort {
  /** Hash of everything that affects resolution in scope (tsconfig paths, package.json exports, ...). */
  configHash(fromFile: string): string;
  resolve(fromFile: string, specifier: string): ResolutionResult;
}
