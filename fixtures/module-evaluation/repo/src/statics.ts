import { register } from './registry';

export class Statics {
  static handler = register('static-field');

  static {
    register('static-block');
  }

  run(): string {
    return 'ran';
  }
}
