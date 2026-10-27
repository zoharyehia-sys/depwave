import { Confidence, MODULE_SYMBOL, type Explanation, type ExplanationStep, type Granularity } from '@depwave/core';

export interface WhyContext {
  base: string;
  head: string;
  granularity: Granularity;
}

const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev);

/**
 * Human explanation of one impacted (or not impacted) file:
 *
 *   ✔ packages/app/src/checkout.test.ts is impacted (symbol level, 0123456789ab...HEAD)
 *
 *     packages/app/src/checkout.test.ts
 *       → runs its top-level code
 *       → which calls renderCheckout                  packages/app/src/checkout.ts:3
 *       → which calls formatCurrency   ◀ changed      packages/utils/src/money.ts:1
 */
export function renderWhy(explanation: Explanation, ctx: WhyContext): string {
  const range = `${ctx.granularity} level, ${short(ctx.base)}...${short(ctx.head)}`;
  switch (explanation.kind) {
    case 'unknown':
      return `✘ ${explanation.target} is not a file depwave knows at ${short(ctx.head)}.\n  Paths are repo-relative, e.g. packages/app/src/checkout.test.ts.\n`;
    case 'not-impacted':
      return [
        `✘ ${explanation.target} is not impacted (${range}).`,
        `  Nothing it depends on is among the ${explanation.changedFiles.length} changed file(s).`,
        '',
      ].join('\n');
    case 'impacted':
      return renderPath(explanation, range);
  }
}

function renderPath(explanation: Extract<Explanation, { kind: 'impacted' }>, range: string): string {
  const [target, ...hops] = explanation.steps;
  const rows = hops.map((step, i) => {
    const seedMark = i === hops.length - 1 ? `  ${seedLabel(explanation)}` : '';
    const uncertain = step.confidence !== undefined && step.confidence < Confidence.certain ? '~ ' : '→ ';
    return { text: `${uncertain}${phrase(step)}${seedMark}`, where: location(step) };
  });
  const width = Math.max(0, ...rows.map((r) => r.text.length)) + 3;

  const lines = [`✔ ${explanation.target} is impacted (${range})`, '', `    ${target!.path}`];
  if (hops.length === 0) lines[2] += `  ${seedLabel(explanation)}`;
  for (const row of rows) lines.push(`      ${row.text.padEnd(width)}${row.where}`.trimEnd());
  lines.push('');
  if (explanation.heuristic) {
    lines.push('  ~ marks a step depwave can\'t prove statically (glob or fully dynamic import); it errs toward running the test.');
  }
  lines.push('  This is the shortest path; others may exist.', '');
  return lines.join('\n');
}

function seedLabel(explanation: Extract<Explanation, { kind: 'impacted' }>): string {
  if (explanation.cause.kind === 'changed') return '◀ changed';
  const paths = explanation.cause.triggers.map((t) => t.path);
  return paths.length > 0 ? `◀ selected because ${paths.join(', ')} changed` : '◀ selected by a global trigger';
}

/** What the previous step does with this one, as a sentence fragment. */
function phrase(step: ExplanationStep): string {
  const name = label(step);
  switch (step.relation) {
    case 'PART_OF':
      return step.symbol === MODULE_SYMBOL ? 'runs its top-level code' : `which contains ${name}`;
    case 'IN_MODULE':
      return "which depends on its file's top-level code";
    case 'CALLS':
      return `which calls ${name}`;
    case 'REFERENCES':
      if (step.symbol === undefined) return `which uses all of ${name}`;
      return step.typeOnly ? `which uses the type ${name}` : `which uses ${name}`;
    case 'IMPORTS':
      return `which imports ${name}`;
    case 'RE_EXPORTS':
      return `which re-exports ${name}`;
    case 'DYNAMIC_IMPORT':
      return step.confidence === Confidence.certain ? `which dynamically imports ${name}` : `which may dynamically import ${name} (template import)`;
    case 'WILDCARD':
      // Reasons: import(expr) / require(expr), a test that spawns processes, or a file depwave could not parse.
      return `which may load or run any module of its package (dynamic import, spawned process, or unparsed code), including ${name}`;
    default:
      return `which depends on ${name}`;
  }
}

function label(step: ExplanationStep): string {
  if (step.symbol === undefined) return step.path;
  if (step.symbol === MODULE_SYMBOL) return `the top-level code of ${step.path}`;
  return step.symbol;
}

function location(step: ExplanationStep): string {
  if (step.symbol === undefined || step.symbol === MODULE_SYMBOL) return step.symbol === undefined ? '' : step.path;
  return step.line === undefined ? step.path : `${step.path}:${step.line}`;
}
