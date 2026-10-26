import { isObject } from './vfs.js';

/**
 * Node's package.json `exports` / `imports` resolution, as a pure function from (map, request, conditions) to
 * candidate targets. Deliberately lenient where the spec is strict: every condition that matches contributes its
 * targets in priority order, so a missing `types` build output can fall through to `default` (or to dist → src mapping)
 * instead of failing. Leniency only ever adds edges, never hides one.
 */

/**
 * Targets for `subpath` ('.' or './x') of an `exports` field, or undefined when the subpath is not exported.
 * Handles the sugar forms (`"exports": "./x.js"`, arrays, condition objects without '.' keys).
 */
export function exportsTargets(exportsField: unknown, subpath: string, conditions: readonly string[]): string[] | undefined {
  const map = isSubpathMap(exportsField) ? exportsField : { '.': exportsField };
  return subpathTargets(map, subpath, conditions);
}

/** Targets for a `#specifier` from an `imports` field, or undefined when it isn't mapped. */
export function importsTargets(importsField: unknown, specifier: string, conditions: readonly string[]): string[] | undefined {
  return isObject(importsField) ? subpathTargets(importsField, specifier, conditions) : undefined;
}

function isSubpathMap(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith('.'));
}

function subpathTargets(map: Record<string, unknown>, request: string, conditions: readonly string[]): string[] | undefined {
  if (Object.hasOwn(map, request) && !request.includes('*')) return targetsOf(map[request], undefined, conditions);

  // Pattern keys ("./*", "./features/*.js"): the longest prefix wins, then the longest key (PATTERN_KEY_COMPARE).
  let best: { key: string; capture: string; prefixLength: number } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star === -1 || key.indexOf('*', star + 1) !== -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (request.length < key.length - 1 || !request.startsWith(prefix) || !request.endsWith(suffix) || request === prefix) continue;
    if (!best || prefix.length > best.prefixLength || (prefix.length === best.prefixLength && key.length > best.key.length)) {
      best = { key, capture: request.slice(prefix.length, request.length - suffix.length), prefixLength: prefix.length };
    }
  }
  return best ? targetsOf(map[best.key], best.capture, conditions) : undefined;
}

/** Flattens a target (string | array | conditions object | null) into candidate strings, in priority order. */
function targetsOf(target: unknown, capture: string | undefined, conditions: readonly string[]): string[] {
  if (typeof target === 'string') return [capture === undefined ? target : target.replaceAll('*', capture)];
  if (Array.isArray(target)) return target.flatMap((t) => targetsOf(t, capture, conditions));
  if (isObject(target)) {
    // Object key order is the package author's priority order.
    return Object.entries(target).flatMap(([condition, value]) =>
      condition === 'default' || conditions.includes(condition) ? targetsOf(value, capture, conditions) : [],
    );
  }
  return []; // null: explicitly not exported
}
