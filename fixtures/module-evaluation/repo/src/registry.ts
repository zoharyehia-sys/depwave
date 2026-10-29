export const handlers: string[] = [];

export function register(name: string): { name: string } {
  handlers.push(name);
  return { name };
}
