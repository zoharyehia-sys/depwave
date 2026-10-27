export class AppError extends Error {
  constructor(message: string) {
    super(`service failed: ${message}`);
  }
}
