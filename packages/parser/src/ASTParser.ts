import { NotImplementedError, type FileFacts, type LanguageId, type ParseInput, type ParserPort } from '@ripple/core';
import type { LanguageRegistry } from './LanguageRegistry.js';

/** Tree-sitter facade. Phase 1 adds the Piscina worker pool and the TypeScript adapter + .scm queries. */
export class ASTParser implements ParserPort {
  readonly version = '0.0.0';

  constructor(private readonly languages: LanguageRegistry) {}

  supports(path: string): LanguageId | undefined {
    return this.languages.languageOf(path);
  }

  async *extract(_files: Iterable<ParseInput>): AsyncIterable<FileFacts> {
    throw new NotImplementedError('ASTParser.extract', 'Phase 1');
  }
}
