import { readFileSync } from 'node:fs';

// One level up from src/ and dist/ alike, so the source, the build and the published bundle all read the same field.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const VERSION = manifest.version;
