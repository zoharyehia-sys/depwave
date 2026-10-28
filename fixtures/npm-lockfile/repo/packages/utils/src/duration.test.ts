import { expect, it } from 'vitest';
import { toMillis } from './index';

it('parses durations', () => expect(toMillis('2s')).toBe(2000));
