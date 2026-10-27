import type { FileFacts, ImportBinding, ImportFact } from '../model/facts.js';
import { nodeId, type NodeId } from '../model/ids.js';

/**
 * What a name exported by (or imported into) a module really is: the defining symbol, or, when that can't be known
 * statically, the whole module (`file:F`, "any part of F"). Never undefined for a resolvable module: unknown → widen.
 */
export type BindingTarget = { kind: 'symbol'; id: NodeId } | { kind: 'module'; id: NodeId };

export interface ReExportResolverDeps {
  facts: ReadonlyMap<string, FileFacts>;
  /** Module resolution: the imported file's path, or undefined for externals and unresolvable specifiers. */
  resolve(fromPath: string, specifier: string): string | undefined;
}

interface LocalBinding extends ImportBinding {
  specifier: string;
  importTypeOnly: boolean;
}

/**
 * Chases exports through barrels so that `import { Button } from '@acme/ui'` binds to `sym:…/Button.ts#Button`,
 * no matter how many `export *` / `export { x } from` layers sit in between.
 *
 * Semantics follow ES modules: explicit exports win over `export *`; `export *` never re-exports `default`;
 * the first `export *` that provides a name wins (ambiguity is a TS error anyway); cycles terminate.
 */
export class ReExportResolver {
  private readonly bindingsByFile = new Map<string, Map<string, LocalBinding>>();
  private readonly symbolsByFile = new Map<string, Set<string>>();
  private readonly memo = new Map<string, BindingTarget | undefined>();

  constructor(private readonly deps: ReExportResolverDeps) {}

  /** Target of `name` as exported by `path`, or undefined if the module doesn't export it. */
  exported(path: string, name: string): BindingTarget | undefined {
    return this.lookup(path, name, new Set());
  }

  /**
   * Target of a reference `root.member…` made inside `path`, where `root` is an imported binding.
   * Undefined when `root` isn't an import, or imports something outside the repository.
   */
  imported(path: string, root: string, member: string | undefined): BindingTarget | undefined {
    const binding = this.bindingsOf(path).get(root);
    if (!binding) return undefined;
    const target = this.deps.resolve(path, binding.specifier);
    if (target === undefined) return undefined; // third-party or unresolved: not a repository edge
    const whole: BindingTarget = { kind: 'module', id: nodeId.file(target) };

    if (binding.imported === '*') {
      // `ns.member`: bind to the member when it's statically known; `ns` used as a value depends on everything.
      return member === undefined ? whole : (this.exported(target, member) ?? whole);
    }
    const bound = this.exported(target, binding.imported) ?? whole;
    // `Class.member` → the method symbol, when the defining file has one.
    if (bound.kind === 'symbol' && member !== undefined) {
      const methodId = `${bound.id}.${member}`;
      const [file, name] = splitSymbolId(methodId);
      if (this.symbolsOf(file).has(name)) return { kind: 'symbol', id: methodId };
    }
    return bound;
  }

  isTypeOnlyBinding(path: string, local: string): boolean {
    const binding = this.bindingsOf(path).get(local);
    return binding !== undefined && (binding.typeOnly === true || binding.importTypeOnly);
  }

  // ─── internals ───────────────────────────────────────────────────────────────

  private lookup(path: string, name: string, visiting: Set<string>): BindingTarget | undefined {
    const key = `${path}\u0000${name}`;
    if (this.memo.has(key)) return this.memo.get(key);
    if (visiting.has(key)) return undefined; // export cycle: no definition along this path
    visiting.add(key);
    const result = this.lookupUncached(path, name, visiting);
    visiting.delete(key);
    this.memo.set(key, result);
    return result;
  }

  private lookupUncached(path: string, name: string, visiting: Set<string>): BindingTarget | undefined {
    const facts = this.deps.facts.get(path);
    if (!facts) return undefined; // not source (asset, JSON): callers widen to the whole module
    const whole: BindingTarget = { kind: 'module', id: nodeId.file(path) };

    for (const fact of facts.exports) {
      if (fact.name !== name) continue;
      switch (fact.kind) {
        case 'local': {
          const local = fact.local ?? name;
          if (this.symbolsOf(path).has(local)) return { kind: 'symbol', id: nodeId.symbol(path, local) };
          // `import { x } from './y'; export { x }`: follow the import.
          return this.imported(path, local, undefined) ?? whole; // CommonJS `exports.x = …` lands here too
        }
        case 'reexport': {
          const target = fact.from === undefined ? undefined : this.deps.resolve(path, fact.from);
          if (target === undefined) return undefined;
          return this.lookup(target, fact.local ?? name, visiting) ?? { kind: 'module', id: nodeId.file(target) };
        }
        case 'reexport-namespace': {
          const target = fact.from === undefined ? undefined : this.deps.resolve(path, fact.from);
          return target === undefined ? undefined : { kind: 'module', id: nodeId.file(target) };
        }
        default:
          break;
      }
    }

    if (name !== 'default') {
      for (const fact of facts.exports) {
        if (fact.kind !== 'reexport-all' || fact.from === undefined) continue;
        const target = this.deps.resolve(path, fact.from);
        const found = target === undefined ? undefined : this.lookup(target, name, visiting);
        if (found) return found;
      }
    }
    return undefined;
  }

  private bindingsOf(path: string): Map<string, LocalBinding> {
    let bindings = this.bindingsByFile.get(path);
    if (!bindings) {
      bindings = new Map();
      for (const fact of this.deps.facts.get(path)?.imports ?? []) {
        if (fact.specifier === undefined) continue;
        for (const binding of fact.bindings) bindings.set(binding.local, { ...binding, specifier: fact.specifier, importTypeOnly: isTypeImport(fact) });
      }
      this.bindingsByFile.set(path, bindings);
    }
    return bindings;
  }

  private symbolsOf(path: string): Set<string> {
    let names = this.symbolsByFile.get(path);
    if (!names) {
      names = new Set((this.deps.facts.get(path)?.symbols ?? []).map((s) => s.name));
      this.symbolsByFile.set(path, names);
    }
    return names;
  }
}

const isTypeImport = (fact: ImportFact): boolean => fact.kind === 'type';

/** `sym:path#name` → [path, name]. */
function splitSymbolId(id: NodeId): [string, string] {
  const body = id.slice('sym:'.length);
  const hash = body.indexOf('#');
  return [body.slice(0, hash), body.slice(hash + 1)];
}
