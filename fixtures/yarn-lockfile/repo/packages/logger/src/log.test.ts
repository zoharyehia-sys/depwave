import { expect, it } from 'vitest';
import { log } from './log';

it('is namespaced', () => expect(log.namespace).toBe('lock'));
