export function main(argv: string[]): string {
  return `created ${argv[0] ?? 'app'}`;
}

main(process.argv.slice(2));
