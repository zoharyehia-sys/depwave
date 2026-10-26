import type { LanguageAdapter, LanguageId } from '@ripple/core';

/** Maps file extensions to language adapters. */
export class LanguageRegistry {
  private readonly byExtension = new Map<string, LanguageAdapter>();

  register(adapter: LanguageAdapter): this {
    for (const ext of adapter.extensions) {
      const existing = this.byExtension.get(ext);
      if (existing) throw new Error(`Extension ${ext} is already handled by ${existing.id}`);
      this.byExtension.set(ext, adapter);
    }
    return this;
  }

  forPath(path: string): LanguageAdapter | undefined {
    const dot = path.lastIndexOf('.');
    return dot === -1 ? undefined : this.byExtension.get(path.slice(dot).toLowerCase());
  }

  languageOf(path: string): LanguageId | undefined {
    return this.forPath(path)?.id;
  }
}
