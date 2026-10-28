import type { ImportCycle } from '@depwave/core';

export interface CyclesContext {
  rev: string;
  /** Imports depwave couldn't resolve: a cycle through one of them is invisible. */
  unresolved: number;
  includeTypeOnly: boolean;
}

const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 *   depwave cycles 0123456789ab: 1 import cycle ✘
 *     1. src/a.ts → src/b.ts → src/c.ts → src/a.ts
 *
 * A component larger than its shortest loop also lists its size: breaking that loop may leave another one.
 */
export function renderCyclesText(cycles: readonly ImportCycle[], ctx: CyclesContext): string {
  const imports = ctx.includeTypeOnly ? 'imports, including type-only ones' : 'runtime imports';
  const lines = [
    cycles.length === 0
      ? `depwave cycles ${short(ctx.rev)}: no import cycles ✔ (${imports})`
      : `depwave cycles ${short(ctx.rev)}: ${plural(cycles.length, 'import cycle')} ✘ (${imports})`,
  ];
  cycles.forEach((cycle, i) => {
    const size = cycle.files.length > cycle.loop.length - 1 ? `   (shortest loop; ${cycle.files.length} files depend on each other)` : '';
    lines.push(`  ${i + 1}. ${cycle.loop.join(' → ')}${size}`);
  });
  if (ctx.unresolved > 0) lines.push(`  ⚠ ${plural(ctx.unresolved, 'unresolved import')}: a cycle through one of them isn't visible (see --format json)`);
  return `${lines.join('\n')}\n`;
}
