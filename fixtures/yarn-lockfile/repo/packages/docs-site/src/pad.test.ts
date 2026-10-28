import { expect, it } from 'vitest';
import { lineNumber } from './pad';

it('pads line numbers', () => expect(lineNumber(7)).toBe('   7'));
