import { Cli, Command } from 'clipanion';
import { VERSION } from './version.js';

/** What each option's value is, for usage lines. Clipanion prints every value as `#0`. */
const VALUE_NAMES: Record<string, string> = {
  '--base': '<rev>',
  '--head': '<rev>',
  '--rev': '<rev>',
  '--format': '<format>',
  '--granularity': '<level>',
  '--level': '<level>',
  '--explain': '<n>',
  '--cwd': '<dir>',
  '--results': '<file>',
  '--results-root': '<dir>',
  '--package': '<name>',
};

// `  --base <rev>     Description`, with the name in bold when colors are on: `\x1b[1m--base <rev>   \x1b[22m    …`.
const OPTION_ROW = /^( {2})(\x1b\[1m)?(--?[a-z][\w-]*(?: <[a-z]+>)?) *(\x1b\[22m)? +(\S.*)$/;

/** Names the values, then re-aligns option tables: the longer names push the description column out. */
function nameValues(text: string): string {
  const lines = text.replace(/(--[a-z][a-z-]*) #0/g, (_, name: string) => `${name} ${VALUE_NAMES[name] ?? '<value>'}`).split('\n');
  for (let start = 0; start < lines.length; start++) {
    let end = start;
    while (end < lines.length && OPTION_ROW.test(lines[end]!)) end++;
    if (end === start) continue;
    const rows = lines.slice(start, end).map((line) => OPTION_ROW.exec(line)!);
    const width = Math.max(...rows.map((row) => row[3]!.length)) + 4;
    rows.forEach(([, indent, bold = '', name = '', unbold = '', description], i) => {
      lines[start + i] = `${indent}${bold}${name}${unbold}${' '.repeat(width - name.length)}${description}`;
    });
    start = end;
  }
  return lines.join('\n');
}

/** Clipanion, with value names in its usage lines and in the "did you mean" of its errors, and our overview. */
export class DepwaveCli extends Cli {
  override usage(...args: Parameters<Cli['usage']>): string {
    // No command: `depwave` with no arguments. Clipanion would list every command with every option.
    if (args[0] === null || args[0] === undefined) return OVERVIEW;
    return nameValues(super.usage(...args));
  }

  override error(...args: Parameters<Cli['error']>): string {
    return nameValues(super.error(...args));
  }
}

const OVERVIEW = `depwave ${VERSION}
Run the tests your change can actually reach, and see why each one was selected.

Usage: depwave <command> [options]

Test selection
  impact          List the test files a diff impacts, grouped by package
  why <file>      Show the dependency chain from a change to a file, or why it isn't impacted
  shadow          Check a full test run's failures against what depwave would have selected

Understanding the repository
  cycles          List import cycles
  graph           Draw the package or file dependency graph (Mermaid or Graphviz)
  cache stats     Show what the analysis cache holds
  cache clear     Empty the analysis cache

Run \`depwave <command> --help\` for its options and examples.
Docs: https://github.com/zoharyehia-sys/depwave#readme
`;

/**
 * `depwave help`, `depwave --help`: one screen, grouped by what people come for. Not the empty path: a command there
 * would swallow unknown commands, which should get clipanion's "did you mean".
 */
export class HelpCommand extends Command {
  static override paths = [['help'], ['-h'], ['--help']];

  async execute(): Promise<number> {
    this.context.stdout.write(OVERVIEW);
    return 0;
  }
}

/** `depwave cache` on its own: clipanion would otherwise answer "Command not found" (or "Multiple commands match"). */
export class CacheHelpCommand extends Command {
  static override paths = [['cache'], ['cache', '--help'], ['cache', '-h']];
  static override usage = Command.Usage({ description: 'Inspect or empty the analysis cache in .depwave/.' });

  async execute(): Promise<number> {
    this.context.stdout.write(
      'Usage: depwave cache <stats|clear> [--cwd <dir>]\n\n  stats    Show what the analysis cache holds and its size on disk\n  clear    Delete everything in it; the next run rebuilds it\n',
    );
    return 0;
  }
}
