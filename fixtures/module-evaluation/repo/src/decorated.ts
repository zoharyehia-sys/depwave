import { register } from './registry';

function tracked(name: string) {
  return <T>(target: T): T => {
    register(name);
    return target;
  };
}

@tracked('decorated')
export class Decorated {
  @tracked('method')
  run(): string {
    return 'ran';
  }
}
