import type { LanguageAdapter, LanguageId } from '@depwave/core';
import { TypeScriptAdapter } from './languages/typescript/TypeScriptAdapter.js';
import type { TreeSitterLanguageAdapter } from './treeSitter.js';

/** Maps file extensions to language adapters. */
export class LanguageRegistry<A extends LanguageAdapter = LanguageAdapter> {
  private readonly byExtension = new Map<string, A>();

  register(adapter: A): this {
    for (const ext of adapter.extensions) {
      const existing = this.byExtension.get(ext);
      if (existing) throw new Error(`Extension ${ext} is already handled by ${existing.id}`);
      this.byExtension.set(ext, adapter);
    }
    return this;
  }

  forPath(path: string): A | undefined {
    const dot = path.lastIndexOf('.');
    return dot === -1 ? undefined : this.byExtension.get(path.slice(dot).toLowerCase());
  }

  languageOf(path: string): LanguageId | undefined {
    return this.forPath(path)?.id;
  }
}

export function createDefaultRegistry(): LanguageRegistry<TreeSitterLanguageAdapter> {
  return new LanguageRegistry<TreeSitterLanguageAdapter>()
    .register(new TypeScriptAdapter('typescript'))
    .register(new TypeScriptAdapter('tsx'))
    .register(new TypeScriptAdapter('javascript'))
    .register(new TypeScriptAdapter('jsx'));
}
