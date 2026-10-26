import type { LanguageId } from './graph.js';

/** Single source of truth for extension → language. Parser adapters must claim exactly these. */
export const LANGUAGE_EXTENSIONS: Readonly<Record<LanguageId, readonly string[]>> = {
  typescript: ['.ts', '.mts', '.cts'],
  tsx: ['.tsx'],
  javascript: ['.js', '.mjs', '.cjs'],
  jsx: ['.jsx'],
  python: ['.py', '.pyi'],
};

const BY_EXTENSION = new Map<string, LanguageId>(
  Object.entries(LANGUAGE_EXTENSIONS).flatMap(([language, exts]) => exts.map((ext) => [ext, language as LanguageId])),
);

export function languageFromPath(path: string): LanguageId | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? undefined : BY_EXTENSION.get(name.slice(dot).toLowerCase());
}
