import { createRunner } from './factory';

export function main(cmd: string): string {
  return createRunner().exec(cmd);
}
