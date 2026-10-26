import { Builtins, Cli } from 'clipanion';
import { ImpactCommand } from './commands/ImpactCommand.js';

export const VERSION = '0.0.0';

export function createCli(): Cli {
  const cli = new Cli({ binaryLabel: 'Ripple', binaryName: 'ripple', binaryVersion: VERSION });
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);
  cli.register(ImpactCommand);
  return cli;
}
