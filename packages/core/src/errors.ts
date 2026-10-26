export class NotImplementedError extends Error {
  constructor(
    readonly feature: string,
    readonly phase: string,
  ) {
    super(`${feature} is not implemented yet (planned for ${phase}).`);
    this.name = 'NotImplementedError';
  }
}
