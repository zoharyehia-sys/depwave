import type { UnresolvedReason } from '../model/graph.js';

export type ResolutionResult = (
  | {
      kind: 'file';
      path: string;
      /**
       * Other files the specifier can load: conditional exports (`import` / `require` / `types`, …) whose targets
       * differ. Which one runs depends on the runtime (a TS `import` compiled to CommonJS takes `require`), so an
       * importer depends on all of them. `path` is the first in the package author's priority order.
       */
      also?: readonly string[];
    }
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
