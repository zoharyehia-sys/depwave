import { Builtins, type Cli } from 'clipanion';
import { CacheClearCommand, CacheStatsCommand } from './commands/CacheCommands.js';
import { CyclesCommand } from './commands/CyclesCommand.js';
import { GraphCommand } from './commands/GraphCommand.js';
import { ImpactCommand } from './commands/ImpactCommand.js';
import { ShadowCommand } from './commands/ShadowCommand.js';
import { WhyCommand } from './commands/WhyCommand.js';
import { CacheHelpCommand, DepwaveCli, HelpCommand } from './help.js';
import { VERSION } from './version.js';

export { VERSION };

/** Clipanion colors whenever the terminal type supports it, even into a pipe or a file: only a TTY gets colors. */
function wantsColors(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['FORCE_COLOR'] !== undefined) return env['FORCE_COLOR'] !== '0';
  return process.stdout.isTTY === true && env['NO_COLOR'] === undefined;
}

export function createCli(): Cli {
  const cli = new DepwaveCli({ binaryLabel: 'Depwave', binaryName: 'depwave', binaryVersion: VERSION, enableColors: wantsColors() });
  cli.register(HelpCommand);
  cli.register(Builtins.VersionCommand);
  cli.register(ImpactCommand);
  cli.register(WhyCommand);
  cli.register(ShadowCommand);
  cli.register(CyclesCommand);
  cli.register(GraphCommand);
  cli.register(CacheHelpCommand);
  cli.register(CacheStatsCommand);
  cli.register(CacheClearCommand);
  return cli;
}
