import { createHash } from 'node:crypto';
import type { Node } from 'web-tree-sitter';

/**
 * A syntax tree's token stream: every leaf token except comments, in order. Whitespace and comment edits don't change
 * a node's hash; anything else (including string contents) does. JSX text is whitespace-collapsed, matching JSX semantics.
 *
 * Collected in one cursor walk per file. Hashing a node is then a binary search plus one hash update over the tokens
 * inside its range, with no per-node calls into Wasm (walking `children` per symbol took a quarter of a cold run).
 */
export class TokenStream {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly texts: string[] = [];

  /** `source` is the exact string the tree was parsed from: node indices are offsets into it. */
  constructor(root: Node, source: string) {
    const cursor = root.walk();
    let visit = true;
    for (;;) {
      if (visit) {
        const type = cursor.nodeType;
        if (type !== 'comment') {
          if (cursor.gotoFirstChild()) continue;
          const start = cursor.startIndex;
          const end = cursor.endIndex;
          const raw = source.slice(start, end);
          const text = type === 'jsx_text' ? raw.trim().replace(/\s+/g, ' ') : raw;
          if (text) {
            this.starts.push(start);
            this.ends.push(end);
            this.texts.push(text);
          }
        }
      }
      if (cursor.gotoNextSibling()) {
        visit = true;
      } else if (cursor.gotoParent()) {
        visit = false;
      } else {
        break;
      }
    }
    cursor.delete();
  }

  /** Hash of the tokens inside `node`. */
  hash(node: Node): string {
    const end = node.endIndex;
    let tokens = '';
    for (let i = this.firstAtOrAfter(node.startIndex); i < this.texts.length && this.ends[i]! <= end; i++) tokens += `${this.texts[i]}\u0001`;
    return createHash('sha1').update(tokens).digest('hex').slice(0, 16);
  }

  /** One hash over several nodes' token streams, in order. Empty input has a stable hash too. */
  combinedHash(nodes: readonly Node[]): string {
    const hash = createHash('sha1');
    for (const node of nodes) hash.update(this.hash(node)).update('\u0002');
    return hash.digest('hex').slice(0, 16);
  }

  private firstAtOrAfter(offset: number): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
