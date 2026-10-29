import type {
  ExportFact,
  FileFacts,
  ImportBinding,
  ImportFact,
  LanguageId,
  ReferenceFact,
  ReferenceKind,
  SourceLocation,
  Span,
  SymbolFact,
  SymbolKind,
} from '@depwave/core';
import type { Node } from 'web-tree-sitter';
import { combinedTokenHash, tokenHash } from '../../hash.js';

export type ExtractedFacts = Omit<FileFacts, 'contentHash' | 'parserVersion'>;

/** Enclosing-symbol name for top-level code. */
export const MODULE = '<module>';

const FUNCTION_LIKE = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const CLASS_LIKE = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const TYPE_ONLY_DECLARATIONS = new Set(['interface_declaration', 'type_alias_declaration']);
/** Expressions that run code when a module is evaluated (function bodies excluded). */
const EFFECTFUL = new Set(['call_expression', 'new_expression', 'await_expression', 'assignment_expression', 'augmented_assignment_expression', 'update_expression']);

/**
 * Extracts imports, exports, top-level symbols and references from a TS/TSX/JS/JSX syntax tree.
 * Pass 1 visits top-level statements (bindings, symbols, exports). Pass 2 walks every code body for references,
 * so a call to a function declared further down the file still resolves.
 */
export function extractTypeScriptFacts(root: Node, path: string, language: LanguageId): ExtractedFacts {
  const extractor = new Extractor(language);
  extractor.run(root);
  return {
    path,
    language,
    imports: extractor.imports,
    exports: extractor.exports,
    symbols: extractor.symbols,
    references: [...extractor.references.values()],
    hasSideEffects: extractor.hasSideEffects,
    moduleHash: combinedTokenHash(extractor.moduleNodes),
    parseErrors: countParseErrors(root),
  };
}

interface Body {
  node: Node;
  from: string;
  /** Enclosing class, so `this.x()` resolves to `Class.x`. */
  cls?: string;
}

class Extractor {
  readonly imports: ImportFact[] = [];
  readonly exports: ExportFact[] = [];
  readonly symbols: SymbolFact[] = [];
  readonly references = new Map<string, ReferenceFact>();
  hasSideEffects = false;
  /** Top-level statements that declare no symbol: what `moduleHash` covers. */
  readonly moduleNodes: Node[] = [];

  /** Every name bound at module scope: imports + top-level declarations. References are only recorded to these. */
  private readonly bound = new Set<string>();
  private readonly bodies: Body[] = [];
  /** `export { a }` may precede `const a`: applied after pass 1. */
  private readonly pendingExports: Array<[local: string, as: true | 'default']> = [];

  constructor(private readonly language: LanguageId) {}

  run(root: Node): void {
    for (const statement of root.namedChildren) {
      const symbolsBefore = this.symbols.length;
      this.statement(statement);
      // A declaration is covered by its symbols' bodyHash; anything else at the top level is module code.
      if (this.symbols.length === symbolsBefore && statement.type !== 'comment') this.moduleNodes.push(statement);
    }
    for (const [local, as] of this.pendingExports) this.markExported(local, as);
    for (const body of this.bodies) this.walk(body.node, body.from, body.cls);
  }

  // ─── pass 1: top-level statements ────────────────────────────────────────────

  private statement(node: Node): void {
    switch (node.type) {
      case 'import_statement':
        return this.importStatement(node);
      case 'export_statement':
        return this.exportStatement(node);
      case 'comment':
      case 'empty_statement':
      case 'hash_bang_line':
        return;
      case 'expression_statement': {
        if (isDirective(node) || this.commonJsExport(node)) return;
        // The grammar wraps a top-level `namespace X {}` in an expression statement.
        const only = node.namedChildren[0];
        if (node.namedChildCount === 1 && only?.type === 'internal_module') {
          this.declaration(only, false, node);
          return;
        }
        break;
      }
    }
    if (this.declaration(node, false, node) === undefined) {
      this.hasSideEffects = true;
      this.bodies.push({ node, from: MODULE });
    }
  }

  private importStatement(node: Node): void {
    const loc = location(node);
    const requireClause = node.namedChildren.find((c) => c.type === 'import_require_clause');
    if (requireClause) {
      // import x = require('y')
      const local = requireClause.namedChildren.find((c) => c.type === 'identifier')?.text;
      const source = requireClause.namedChildren.find((c) => c.type === 'string');
      if (source) this.addImport({ kind: 'require', specifier: stringValue(source), bindings: local ? [{ imported: '*', local }] : [], loc });
      return;
    }

    const source = node.childForFieldName('source');
    if (!source) return;
    const specifier = stringValue(source);
    const clause = node.namedChildren.find((c) => c.type === 'import_clause');
    if (!clause) {
      this.addImport({ kind: 'side-effect', specifier, bindings: [], loc });
      return;
    }

    const bindings: ImportBinding[] = [];
    for (const part of clause.namedChildren) {
      if (part.type === 'identifier') {
        bindings.push({ imported: 'default', local: part.text });
      } else if (part.type === 'namespace_import') {
        const local = part.namedChildren.find((c) => c.type === 'identifier')?.text;
        if (local) bindings.push({ imported: '*', local });
      } else if (part.type === 'named_imports') {
        for (const spec of part.namedChildren.filter((c) => c.type === 'import_specifier')) {
          const name = moduleExportName(spec.childForFieldName('name'));
          if (name === undefined) continue;
          const binding: ImportBinding = { imported: name, local: spec.childForFieldName('alias')?.text ?? name };
          if (hasToken(spec, 'type')) binding.typeOnly = true;
          bindings.push(binding);
        }
      }
    }
    this.addImport({ kind: hasToken(node, 'type') ? 'type' : 'static', specifier, bindings, loc });
  }

  private exportStatement(node: Node): void {
    const typeOnly = hasToken(node, 'type');
    const source = node.childForFieldName('source');

    if (source) {
      const from = stringValue(source);
      const namespace = node.namedChildren.find((c) => c.type === 'namespace_export');
      const clause = node.namedChildren.find((c) => c.type === 'export_clause');
      if (namespace) {
        const name = moduleExportName(namespace.namedChildren.at(-1)) ?? '*';
        this.exports.push({ kind: 'reexport-namespace', name, from, typeOnly });
      } else if (clause) {
        for (const { name, alias, specTypeOnly } of exportSpecifiers(clause)) {
          this.exports.push({ kind: 'reexport', name: alias ?? name, local: name, from, typeOnly: typeOnly || specTypeOnly });
        }
      } else {
        this.exports.push({ kind: 'reexport-all', name: '*', from, typeOnly });
      }
      return;
    }

    const isDefault = hasToken(node, 'default');
    const declaration = node.childForFieldName('declaration');
    if (declaration) {
      const names = this.declaration(declaration, isDefault ? 'default' : true, node) ?? [];
      const declTypeOnly = TYPE_ONLY_DECLARATIONS.has(declaration.type);
      for (const name of names) {
        this.exports.push({ kind: 'local', name: isDefault ? 'default' : name, local: name, typeOnly: declTypeOnly });
      }
      return;
    }

    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    if (clause) {
      for (const { name, alias, specTypeOnly } of exportSpecifiers(clause)) {
        const exported = alias ?? name;
        this.exports.push({ kind: 'local', name: exported, local: name, typeOnly: typeOnly || specTypeOnly });
        this.pendingExports.push([name, exported === 'default' ? 'default' : true]);
      }
      return;
    }

    // `export default <expr>` and TS `export = <expr>`
    const value = node.childForFieldName('value') ?? (hasToken(node, '=') ? node.namedChildren.find((c) => c.type !== 'comment') : undefined);
    if (value) this.defaultExportValue(node, value);
  }

  private defaultExportValue(statement: Node, value: Node): void {
    if (value.type === 'identifier') {
      this.exports.push({ kind: 'local', name: 'default', local: value.text, typeOnly: false });
      this.pendingExports.push([value.text, 'default']);
      return;
    }
    // Anonymous default: give it a `default` symbol so `import x from` can bind to something.
    const name = value.childForFieldName('name')?.text ?? 'default';
    const kind: SymbolKind = FUNCTION_LIKE.has(value.type) ? this.functionKind(name) : CLASS_LIKE.has(value.type) ? 'class' : 'variable';
    this.addSymbol(name, kind, 'default', statement, value);
    this.exports.push({ kind: 'local', name: 'default', local: name, typeOnly: false });
    if (CLASS_LIKE.has(value.type)) this.classMembers(value, name);
    this.bodies.push({ node: value, from: name, ...(CLASS_LIKE.has(value.type) ? { cls: name } : {}) });
    if (hasModuleEffect(value)) this.markEffectful([name]);
  }

  /** `module.exports = …`, `module.exports.x = …`, `exports.x = …` */
  private commonJsExport(statement: Node): boolean {
    const assignment = statement.namedChildren[0];
    if (assignment?.type !== 'assignment_expression') return false;
    const target = dotted(assignment.childForFieldName('left'));
    if (target === undefined) return false;

    let name: string | undefined;
    if (target === 'module.exports') name = 'default';
    else if (target.startsWith('module.exports.')) name = target.slice('module.exports.'.length);
    else if (target.startsWith('exports.')) name = target.slice('exports.'.length);
    if (name === undefined || name.includes('.')) return false;

    this.exports.push({ kind: 'local', name, local: name, typeOnly: false });
    const value = assignment.childForFieldName('right');
    if (value) this.bodies.push({ node: value, from: MODULE });
    return true;
  }

  /**
   * Registers a declaration's symbols. `outer` is the node whose span the symbol gets (the export statement when
   * exported). Returns the declared names, or undefined if `node` is not a declaration.
   */
  private declaration(node: Node, exported: boolean | 'default', outer: Node): string[] | undefined {
    const name = node.childForFieldName('name')?.text;
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_signature': {
        const symbol = name ?? 'default';
        this.addSymbol(symbol, this.functionKind(symbol), exported, outer, node);
        this.bodies.push({ node, from: symbol });
        return [symbol];
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const symbol = name ?? 'default';
        this.addSymbol(symbol, 'class', exported, outer, node);
        this.classMembers(node, symbol);
        this.bodies.push({ node, from: symbol, cls: symbol });
        return [symbol];
      }
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration':
      case 'internal_module':
      case 'module': {
        if (name === undefined || node.childForFieldName('name')?.type === 'string') return []; // declare module 'x'
        const kind: SymbolKind =
          node.type === 'interface_declaration' ? 'interface' : node.type === 'type_alias_declaration' ? 'type' : node.type === 'enum_declaration' ? 'enum' : 'variable';
        this.addSymbol(name, kind, exported, outer, node);
        this.bodies.push({ node, from: name });
        return [name];
      }
      case 'lexical_declaration':
      case 'variable_declaration':
        return this.variables(node, exported, outer);
      case 'ambient_declaration': {
        const inner = node.namedChildren.find((c) => c.type !== 'comment');
        return inner ? (this.declaration(inner, exported, outer) ?? []) : [];
      }
      case 'import_alias': // import x = Foo.Bar
        if (name) this.bound.add(name);
        return [];
      default:
        return undefined;
    }
  }

  private variables(node: Node, exported: boolean | 'default', outer: Node): string[] {
    const declarators = node.namedChildren.filter((c) => c.type === 'variable_declarator');
    const names: string[] = [];
    for (const declarator of declarators) {
      const value = declarator.childForFieldName('value');
      if (value && isRequireCall(value)) {
        this.requireCall(value); // top-level `const x = require('y')` is an import, not a symbol
        continue;
      }
      const declared = patternNames(declarator.childForFieldName('name'));
      const kind: SymbolKind = value && FUNCTION_LIKE.has(value.type) ? this.functionKind(declared[0] ?? '') : 'variable';
      // A single-declarator statement owns the whole statement span (incl. `export`), so its hunks map to the symbol.
      const spanNode = declarators.length === 1 ? outer : declarator;
      for (const name of declared) this.addSymbol(name, kind, exported, spanNode, declarator);
      names.push(...declared);
      if (value) {
        this.bodies.push({ node: value, from: declared[0] ?? MODULE });
        if (hasModuleEffect(value)) this.markEffectful(declared);
      }
    }
    return names;
  }

  private classMembers(cls: Node, className: string): void {
    const body = cls.childForFieldName('body');
    for (const member of body?.namedChildren ?? []) {
      if (member.type !== 'method_definition' && member.type !== 'abstract_method_signature' && member.type !== 'method_signature') continue;
      const name = member.childForFieldName('name')?.text;
      if (name) this.addSymbol(`${className}.${name}`, 'method', false, member, member, className);
    }
  }

  private functionKind(name: string): SymbolKind {
    return (this.language === 'tsx' || this.language === 'jsx') && /^[A-Z]/.test(name) ? 'component' : 'function';
  }

  /** These top-level symbols' initializers run code when the module loads (`const h = register()`). */
  private markEffectful(names: readonly string[]): void {
    this.hasSideEffects = true;
    for (const symbol of this.symbols) if (symbol.parent === undefined && names.includes(symbol.name)) symbol.effectful = true;
  }

  private addSymbol(name: string, kind: SymbolKind, exported: boolean | 'default', spanNode: Node, hashNode: Node, parent?: string): void {
    const span = toSpan(spanNode);
    const bodyHash = tokenHash(hashNode);
    if (!parent) this.bound.add(name);

    // Overloads and declaration merging (interface + namespace) produce one symbol spanning all declarations.
    const existing = this.symbols.find((s) => s.name === name);
    if (existing) {
      existing.span = {
        startLine: Math.min(existing.span.startLine, span.startLine),
        endLine: Math.max(existing.span.endLine, span.endLine),
        startByte: Math.min(existing.span.startByte, span.startByte),
        endByte: Math.max(existing.span.endByte, span.endByte),
      };
      existing.bodyHash = `${existing.bodyHash}+${bodyHash}`;
      existing.exported = mergeExported(existing.exported, exported);
      return;
    }
    const symbol: SymbolFact = { name, kind, exported, span, bodyHash };
    if (parent) symbol.parent = parent;
    this.symbols.push(symbol);
  }

  private markExported(local: string, as: true | 'default'): void {
    const symbol = this.symbols.find((s) => s.name === local);
    if (symbol) symbol.exported = mergeExported(symbol.exported, as);
  }

  private addImport(fact: ImportFact): void {
    this.imports.push(fact);
    for (const { local } of fact.bindings) this.bound.add(local);
  }

  // ─── pass 2: references, dynamic imports, nested requires ────────────────────

  private walk(node: Node, from: string, cls?: string): void {
    switch (node.type) {
      case 'comment':
      case 'jsx_closing_element': // repeats the opening tag's name; already recorded as jsx
        return;
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'import') return this.dynamicImport(node, from, cls);
        if (isRequireCall(node) && !this.bound.has('require')) return this.requireCall(node, from);
        const globKind = globCallKind(fn, this.bound);
        if (globKind) return this.globImport(node, globKind, from);
        this.callee(fn, 'call', from, cls);
        for (const field of ['type_arguments', 'arguments']) {
          const child = node.childForFieldName(field);
          if (child) this.walk(child, from, cls);
        }
        return;
      }
      case 'new_expression': {
        this.callee(node.childForFieldName('constructor'), 'call', from, cls);
        const args = node.childForFieldName('arguments');
        if (args) this.walk(args, from, cls);
        return;
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element': {
        const name = node.childForFieldName('name');
        const target = name ? dotted(name) : undefined;
        // Lowercase tags are intrinsic HTML elements, not components.
        if (target !== undefined && (/^[A-Z]/.test(target) || target.includes('.'))) this.reference('jsx', from, target, name!, cls);
        for (const child of node.namedChildren) if (child.id !== name?.id) this.walk(child, from, cls);
        return;
      }
      case 'extends_clause': {
        this.callee(node.childForFieldName('value'), 'extends', from, cls);
        const typeArgs = node.childForFieldName('type_arguments');
        if (typeArgs) this.walk(typeArgs, from, cls);
        return;
      }
      case 'member_expression': {
        const target = dotted(node);
        if (target !== undefined) return this.reference('reference', from, target, node, cls);
        break;
      }
      case 'nested_type_identifier':
        return this.reference('type', from, node.text, node, cls);
      case 'type_identifier':
        return this.reference('type', from, node.text, node, cls);
      case 'identifier':
      case 'shorthand_property_identifier':
        return this.reference('reference', from, node.text, node, cls);
      case 'method_definition':
        if (cls) from = `${cls}.${node.childForFieldName('name')?.text ?? '?'}`;
        break;
    }
    const skip = declaredName(node);
    for (const child of node.namedChildren) if (child.id !== skip) this.walk(child, from, cls);
  }

  private callee(fn: Node | null, kind: ReferenceKind, from: string, cls: string | undefined): void {
    if (!fn) return;
    const target = dotted(fn);
    if (target !== undefined) this.reference(kind, from, target, fn, cls);
    else this.walk(fn, from, cls);
  }

  private reference(kind: ReferenceKind, from: string, to: string, node: Node, cls: string | undefined): void {
    let target = to;
    if (target === 'this' || target.startsWith('this.')) {
      if (!cls) return;
      target = cls + target.slice(4); // this.save → UserService.save
    }
    if (!this.bound.has(target.split('.')[0]!)) return; // locals, params and globals are not graph edges
    const key = `${from}\u0000${kind}\u0000${target}`;
    if (!this.references.has(key)) this.references.set(key, { kind, from, to: target, loc: location(node) });
  }

  private dynamicImport(call: Node, from: string, cls: string | undefined): void {
    const arg = call.childForFieldName('arguments')?.namedChildren[0];
    const fact: ImportFact = { kind: 'dynamic', bindings: [], loc: location(call) };
    if (from !== MODULE) fact.from = from;
    const literal = arg ? literalOrPattern(arg) : undefined;
    if (literal?.specifier !== undefined) fact.specifier = literal.specifier;
    else if (literal?.pattern !== undefined) fact.pattern = literal.pattern;
    else if (arg) this.walk(arg, from, cls); // fully dynamic: still record which bound names feed it
    this.imports.push(fact);
  }

  /**
   * `import.meta.glob('./pages/*.ts')` (Vite) and `require.context('./icons', true, /…/)` (webpack) load every matching
   * file: a glob dynamic import. Negated (`!…`) patterns are skipped (that only over-approximates); a pattern that isn't
   * relative is fully dynamic, which widens to the package.
   */
  private globImport(call: Node, kind: 'import.meta.glob' | 'require.context', from: string): void {
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    const first = args[0];
    const patterns: string[] = [];
    if (kind === 'require.context') {
      if (first?.type === 'string') patterns.push(`${stringValue(first).replace(/\/$/, '')}/*`);
    } else if (first?.type === 'string') {
      patterns.push(stringValue(first));
    } else if (first?.type === 'array') {
      for (const item of first.namedChildren) if (item.type === 'string') patterns.push(stringValue(item));
    }

    const loc = location(call);
    const positive = patterns.filter((p) => !p.startsWith('!'));
    if (positive.length === 0) {
      this.imports.push({ kind: 'dynamic', bindings: [], loc, ...(from !== MODULE ? { from } : {}) });
      return;
    }
    for (const glob of positive) {
      const relative = glob.startsWith('./') || glob.startsWith('../');
      const fact: ImportFact = { kind: 'dynamic', bindings: [], loc };
      if (relative) fact.pattern = simplifyGlob(glob);
      if (from !== MODULE) fact.from = from;
      this.imports.push(fact);
    }
  }

  private requireCall(call: Node, from: string = MODULE): void {
    const arg = call.childForFieldName('arguments')?.namedChildren[0];
    const fact: ImportFact = { kind: 'require', bindings: requireBindings(call), loc: location(call) };
    if (from !== MODULE) fact.from = from;
    const literal = arg ? literalOrPattern(arg) : undefined;
    if (literal?.specifier !== undefined) fact.specifier = literal.specifier;
    else if (literal?.pattern !== undefined) fact.pattern = literal.pattern;
    this.addImport(fact);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function location(node: Node): SourceLocation {
  return { line: node.startPosition.row + 1, col: node.startPosition.column + 1 };
}

function toSpan(node: Node): Span {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, startByte: node.startIndex, endByte: node.endIndex };
}

function hasToken(node: Node, token: string): boolean {
  return node.children.some((c) => !c.isNamed && c.type === token);
}

function stringValue(node: Node): string {
  return node.type === 'string' ? node.text.slice(1, -1) : node.text;
}

/** `name` or `"quoted name"` in import/export specifiers. */
function moduleExportName(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  return node.type === 'string' ? stringValue(node) : node.text;
}

function exportSpecifiers(clause: Node): Array<{ name: string; alias?: string; specTypeOnly: boolean }> {
  const specs: Array<{ name: string; alias?: string; specTypeOnly: boolean }> = [];
  for (const spec of clause.namedChildren.filter((c) => c.type === 'export_specifier')) {
    const name = moduleExportName(spec.childForFieldName('name'));
    if (name === undefined) continue;
    const alias = moduleExportName(spec.childForFieldName('alias'));
    specs.push(alias === undefined ? { name, specTypeOnly: hasToken(spec, 'type') } : { name, alias, specTypeOnly: hasToken(spec, 'type') });
  }
  return specs;
}

function mergeExported(a: boolean | 'default', b: boolean | 'default'): boolean | 'default' {
  if (a === true || b === true) return true;
  return a === 'default' || b === 'default' ? 'default' : false;
}

function isDirective(statement: Node): boolean {
  const only = statement.namedChildren;
  return only.length === 1 && only[0]!.type === 'string';
}

function isRequireCall(node: Node): boolean {
  if (node.type !== 'call_expression') return false;
  const fn = node.childForFieldName('function');
  return fn?.type === 'identifier' && fn.text === 'require';
}

/** `a`, `a.b.c`, `this.x`; undefined for computed or call-based expressions. */
function dotted(node: Node | null): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'property_identifier':
    case 'private_property_identifier':
    case 'this':
      return node.text;
    case 'nested_identifier':
      return node.text.replace(/\s+/g, '');
    case 'member_expression': {
      const object = dotted(node.childForFieldName('object'));
      const property = node.childForFieldName('property');
      return object !== undefined && property ? `${object}.${property.text}` : undefined;
    }
    default:
      return undefined;
  }
}

/** Identifiers bound by a declarator name: `a`, `{ a, b: c }`, `[a, ...rest]`. */
function patternNames(node: Node | null): string[] {
  if (!node) return [];
  if (node.type === 'identifier') return [node.text];
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'shorthand_property_identifier_pattern') names.push(child.text);
    else if (child.type === 'pair_pattern') names.push(...patternNames(child.childForFieldName('value')));
    else if (child.type === 'object_assignment_pattern' || child.type === 'assignment_pattern') names.push(...patternNames(child.childForFieldName('left') ?? child.namedChildren[0] ?? null));
    else names.push(...patternNames(child));
  }
  return names;
}

/** Bindings for `const x = require('m')` and `const { a, b: c } = require('m')`. */
function requireBindings(call: Node): ImportBinding[] {
  const declarator = call.parent;
  if (declarator?.type !== 'variable_declarator' || declarator.childForFieldName('value')?.id !== call.id) return [];
  const pattern = declarator.childForFieldName('name');
  if (!pattern) return [];
  if (pattern.type === 'identifier') return [{ imported: '*', local: pattern.text }];
  const bindings: ImportBinding[] = [];
  for (const child of pattern.type === 'object_pattern' ? pattern.namedChildren : []) {
    if (child.type === 'shorthand_property_identifier_pattern') bindings.push({ imported: child.text, local: child.text });
    if (child.type === 'pair_pattern') {
      const key = child.childForFieldName('key')?.text;
      const value = child.childForFieldName('value');
      if (key && value?.type === 'identifier') bindings.push({ imported: key, local: value.text });
    }
  }
  return bindings;
}

/**
 * String literal → specifier. Template literal with a static prefix → glob (`./locales/${l}.ts` → `./locales/*.ts`).
 * No static prefix (`${dir}/x`) is too vague to glob: treated as fully dynamic.
 */
function literalOrPattern(arg: Node): { specifier?: string; pattern?: string } | undefined {
  if (arg.type === 'string') return { specifier: stringValue(arg) };
  if (arg.type !== 'template_string') return undefined;

  let text = '';
  let hasSubstitution = false;
  for (const part of arg.namedChildren) {
    if (part.type === 'template_substitution') {
      if (text === '') return undefined;
      hasSubstitution = true;
      if (!text.endsWith('*')) text += '*';
    } else {
      text += part.text;
    }
  }
  return hasSubstitution ? { pattern: text } : { specifier: text };
}

/** `import.meta.glob(…)` / `import.meta.globEager(…)` / `require.context(…)` calls, unless `require` is shadowed. */
function globCallKind(fn: Node | null, bound: ReadonlySet<string>): 'import.meta.glob' | 'require.context' | undefined {
  if (fn?.type !== 'member_expression') return undefined;
  const object = fn.childForFieldName('object');
  const property = fn.childForFieldName('property')?.text;
  if (object?.type === 'meta_property' && (property === 'glob' || property === 'globEager')) return 'import.meta.glob';
  if (object?.type === 'identifier' && object.text === 'require' && property === 'context' && !bound.has('require')) return 'require.context';
  return undefined;
}

/**
 * Reduces a glob to the `*`-only form the linker matches (where `*` spans directories): `**` and `**\/` collapse to
 * `*`; anything fancier (`{a,b}`, `[x]`, `?`) cuts the pattern there and matches everything below, a superset.
 */
export function simplifyGlob(glob: string): string {
  const special = glob.search(/[{[?]/);
  const cut = special === -1 ? glob : `${glob.slice(0, special)}*`;
  return cut.replace(/\*\*\/?/g, '*').replace(/\*+/g, '*');
}

/** Name node of a declaration-like node, which the reference walk must not report as a use. */
function declaredName(node: Node): number | undefined {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_expression':
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class':
    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration':
    case 'variable_declarator':
    case 'internal_module':
      return node.childForFieldName('name')?.id;
    default:
      return undefined;
  }
}

/** True if evaluating `node` at module load runs code. Function and class bodies only run later. */
function hasModuleEffect(node: Node): boolean {
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (EFFECTFUL.has(current.type)) return true;
    if (FUNCTION_LIKE.has(current.type) || CLASS_LIKE.has(current.type)) continue;
    stack.push(...current.namedChildren);
  }
  return false;
}

export function countParseErrors(root: Node): number {
  if (!root.hasError) return 0;
  let count = 0;
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'ERROR' || current.isMissing) count++;
    if (current.hasError) stack.push(...current.children);
  }
  return count;
}
