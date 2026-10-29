import type { FileFacts, LanguageId, ParseInput, ParserPort } from '@depwave/core';
import { createDefaultRegistry, type LanguageRegistry } from './LanguageRegistry.js';
import { loadTreeSitter, type TreeSitterLanguageAdapter, type TreeSitterRuntime } from './treeSitter.js';

/**
 * Part of every facts cache key. Bump it whenever extraction output can change: extractor logic,
 * web-tree-sitter or grammar upgrades.
 */
export const PARSER_VERSION = 'ts-4';

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

      yield { ...this.extractOne(runtime, adapter, file), contentHash: file.contentHash, parserVersion: this.version };
    }
  }

  /** One file's facts. A crash here (stack overflow on generated code, grammar bug) must not sink the whole run. */
  private extractOne(runtime: TreeSitterRuntime, adapter: TreeSitterLanguageAdapter, file: ParseInput): Omit<FileFacts, 'contentHash' | 'parserVersion'> {
    const tree = runtime.parserFor(adapter.grammar).parse(file.content);
    try {
      if (!tree) throw new Error('Tree-sitter returned no tree');
      return adapter.extractFacts(tree, file.content, file.path);
    } catch (error) {
      return {
        path: file.path,
        language: file.language,
        imports: [],
        exports: [],
        symbols: [],
        references: [],
        hasSideEffects: true,
        moduleHash: '',
        parseErrors: 0,
        failed: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    } finally {
      tree?.delete(); // WASM memory is not garbage-collected
    }
  }
}
