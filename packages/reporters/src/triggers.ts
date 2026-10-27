import type { GlobalTrigger } from '@depwave/core';

export interface TriggerGroup {
  /** Every trigger in the group shares kind and scope. */
  sample: GlobalTrigger;
  paths: string[];
}

/** Triggers of the same kind and scope, together: 18 changed fixture files are one note, not 18. */
export function groupTriggers(triggers: readonly GlobalTrigger[]): TriggerGroup[] {
  const groups = new Map<string, TriggerGroup>();
  for (const trigger of triggers) {
    const key = `${trigger.kind}\u0000${trigger.scope?.join(',') ?? '*'}`;
    const group = groups.get(key);
    if (group) {
      if (!group.paths.includes(trigger.path)) group.paths.push(trigger.path);
    } else {
      groups.set(key, { sample: trigger, paths: [trigger.path] });
    }
  }
  return [...groups.values()];
}

/** `a`, `b`, `c` and 15 more: at most `shown` names, wrapped by `wrap` (e.g. backticks). */
export function listPaths(paths: readonly string[], shown = 3, wrap = (p: string) => p): string {
  const head = paths.slice(0, shown).map(wrap);
  const rest = paths.length - head.length;
  if (rest > 0) return `${head.join(', ')} and ${rest} more`;
  return head.length <= 1 ? head.join('') : `${head.slice(0, -1).join(', ')} and ${head.at(-1)}`;
}
