import { AppError } from './errors';

function run(cmd: string): string {
  if (!cmd) throw new AppError('empty command');
  return cmd.toUpperCase();
}

export class Service {
  exec(cmd: string): string {
    return run(cmd);
  }
}
