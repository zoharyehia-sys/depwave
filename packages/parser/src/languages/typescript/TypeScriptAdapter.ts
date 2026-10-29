import { LANGUAGE_EXTENSIONS } from '@depwave/core';
import type { Tree } from 'web-tree-sitter';
import type { GrammarId, TreeSitterLanguageAdapter } from '../../treeSitter.js';
import { extractTypeScriptFacts, type ExtractedFacts } from './extract.js';

export type JsLikeLanguage = 'typescript' | 'tsx' | 'javascript' | 'jsx';

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * One adapter class for the whole JS family. `.ts` uses the TypeScript grammar (where `<T>x` is a cast);
 * everything else uses TSX, which also parses plain JS and JSX.
 */
export class TypeScriptAdapter implements TreeSitterLanguageAdapter {
  readonly extensions: readonly string[];
  readonly grammar: GrammarId;

  constructor(readonly id: JsLikeLanguage) {
    this.extensions = LANGUAGE_EXTENSIONS[id];
    this.grammar = id === 'typescript' ? 'typescript' : 'tsx';
  }

  extractFacts(tree: Tree, source: string, path: string): ExtractedFacts {
    return extractTypeScriptFacts(tree.rootNode, source, path, this.id);
  }

  isTestFile(path: string): boolean {
    return TEST_FILE.test(path) || path.split('/').includes('__tests__');
  }
}
