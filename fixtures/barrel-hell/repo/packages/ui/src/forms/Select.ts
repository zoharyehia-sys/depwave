export function Select(name: string, options: string[]): string {
  const items = options.map((o) => `<option>${o}</option>`).join('');
  return `<select name="${name}">${items}</select>`;
}
