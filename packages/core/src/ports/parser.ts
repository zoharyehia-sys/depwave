import type { FileFacts } from '../model/facts.js';
import type { LanguageId } from '../model/graph.js';
import type { SourceFile } from '../model/workspace.js';

export interface ParseInput extends SourceFile {
  content: string;
}

/** Turns files into facts. Knows nothing about other files: cross-file work happens in the link phase. */
export interface ParserPort {
  /** Part of every facts cache key: bumping it invalidates all cached facts. */
  readonly version: string;
  supports(path: string): LanguageId | undefined;
  extract(files: Iterable<ParseInput>): AsyncIterable<FileFacts>;
}

/**
 * One per language. Language support is mostly data (Tree-sitter grammar + .scm queries) plus this adapter.
 * `extensions` must match LANGUAGE_EXTENSIONS for its id. `TTree` stays generic so core never depends on Tree-sitter.
 */
export interface LanguageAdapter<TTree = unknown> {
  readonly id: LanguageId;
  readonly extensions: readonly string[];
  extractFacts(tree: TTree, source: string, path: string): Omit<FileFacts, 'contentHash' | 'parserVersion'>;
  isTestFile(path: string): boolean;
}
