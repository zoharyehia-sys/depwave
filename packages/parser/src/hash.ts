import { createHash } from 'node:crypto';
import type { Node } from 'web-tree-sitter';

/**
 * Hash of a node's token stream: every leaf token except comments, in order. Whitespace and comment edits don't
 * change it; anything else (including string contents) does. JSX text is whitespace-collapsed, matching JSX semantics.
 */
export function tokenHash(node: Node): string {
  const hash = createHash('sha1');
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'comment') continue;
    if (current.childCount === 0) {
      const text = current.type === 'jsx_text' ? current.text.trim().replace(/\s+/g, ' ') : current.text;
      if (text) hash.update(text).update('\u0001');
      continue;
    }
    const children = current.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return hash.digest('hex').slice(0, 16);
}
