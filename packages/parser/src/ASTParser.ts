import type { FileFacts, LanguageId, ParseInput, ParserPort } from '@depwave/core';
import { createDefaultRegistry, type LanguageRegistry } from './LanguageRegistry.js';
import { loadTreeSitter, type TreeSitterLanguageAdapter } from './treeSitter.js';

/**
 * Part of every facts cache key. Bump it whenever extraction output can change: extractor logic,
 * web-tree-sitter or grammar upgrades.
 */
export const PARSER_VERSION = 'ts-1';

/** Tree-sitter facade: source files in, FileFacts out. Sequential for now; the Piscina worker pool comes later. */
export class ASTParser implements ParserPort {
  readonly version = PARSER_VERSION;

  constructor(private readonly languages: LanguageRegistry<TreeSitterLanguageAdapter> = createDefaultRegistry()) {}

  supports(path: string): LanguageId | undefined {
    return this.languages.languageOf(path);
  }

  async *extract(files: Iterable<ParseInput>): AsyncIterable<FileFacts> {
    const runtime = await loadTreeSitter();
    for (const file of files) {
      const adapter = this.languages.forPath(file.path);
      if (!adapter) throw new Error(`No language adapter for ${file.path}`);

      const tree = runtime.parserFor(adapter.grammar).parse(file.content);
      if (!tree) throw new Error(`Tree-sitter failed to parse ${file.path}`);
      let facts: Omit<FileFacts, 'contentHash' | 'parserVersion'>;
      try {
        facts = adapter.extractFacts(tree, file.content, file.path);
      } finally {
        tree.delete(); // WASM memory is not garbage-collected
      }
      yield { ...facts, contentHash: file.contentHash, parserVersion: this.version };
    }
  }
}
