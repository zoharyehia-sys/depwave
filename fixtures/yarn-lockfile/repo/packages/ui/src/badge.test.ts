import { expect, it } from 'vitest';
import { badgeClass, fadeMillis } from './index';

it('builds class names', () => expect(badgeClass(true)).toBe('badge badge--active'));
it('fades quickly', () => expect(fadeMillis()).toBe(250));
