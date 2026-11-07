import { fileURLToPath } from 'node:url';
import { Language, Parser, type Tree } from 'web-tree-sitter';
import type { LanguageAdapter } from '@depwave/core';

/**
 * WASM Tree-sitter (web-tree-sitter): no native build, identical behaviour on every OS and inside worker threads.
 * The grammars are vendored in `grammars/` (see its README), one level up from src/, dist/ and the published bundle.
 */
export type GrammarId = 'typescript' | 'tsx';

const GRAMMAR_FILES: Record<GrammarId, URL> = {
  typescript: new URL('../grammars/tree-sitter-typescript.wasm', import.meta.url),
  tsx: new URL('../grammars/tree-sitter-tsx.wasm', import.meta.url),
};

/** A language adapter that knows which Tree-sitter grammar parses its files. */
export interface TreeSitterLanguageAdapter extends LanguageAdapter<Tree> {
  readonly grammar: GrammarId;
}

export interface TreeSitterRuntime {
  /** One reusable parser per grammar. Not safe to share across concurrent parses (we parse sequentially). */
  parserFor(grammar: GrammarId): Parser;
}

let runtime: Promise<TreeSitterRuntime> | undefined;

/** Loads the WASM runtime and all grammars once per process. */
export function loadTreeSitter(): Promise<TreeSitterRuntime> {
  runtime ??= init().catch((error: unknown) => {
    runtime = undefined; // let a later call retry instead of caching the failure forever
    throw error;
  });
  return runtime;
}

async function init(): Promise<TreeSitterRuntime> {
  await Parser.init();
  const entries = await Promise.all(
    Object.entries(GRAMMAR_FILES).map(async ([id, file]) => [id as GrammarId, await Language.load(fileURLToPath(file))] as const),
  );
  const languages = new Map(entries);
  const parsers = new Map<GrammarId, Parser>();

  return {
    parserFor(grammar) {
      let parser = parsers.get(grammar);
      if (!parser) {
        parser = new Parser();
        parser.setLanguage(languages.get(grammar) ?? null);
        parsers.set(grammar, parser);
      }
      return parser;
    },
  };
}
