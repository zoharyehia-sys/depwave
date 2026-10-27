import { Service } from './service';

export interface Runner {
  exec(cmd: string): string;
}

// Callers only ever see the interface: the method call below cannot be bound statically.
export function createRunner(): Runner {
  return new Service();
}
