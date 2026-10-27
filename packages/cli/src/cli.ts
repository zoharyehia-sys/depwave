import { Builtins, Cli } from 'clipanion';
import { CacheClearCommand, CacheStatsCommand } from './commands/CacheCommands.js';
import { ImpactCommand } from './commands/ImpactCommand.js';
import { ShadowCommand } from './commands/ShadowCommand.js';
import { WhyCommand } from './commands/WhyCommand.js';
import { VERSION } from './version.js';

export { VERSION };

export function createCli(): Cli {
  const cli = new Cli({ binaryLabel: 'Depwave', binaryName: 'depwave', binaryVersion: VERSION });
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);
  cli.register(ImpactCommand);
  cli.register(WhyCommand);
  cli.register(ShadowCommand);
  cli.register(CacheStatsCommand);
  cli.register(CacheClearCommand);
  return cli;
}
