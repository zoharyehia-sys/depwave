import clsx from 'clsx';
import { toMillis } from '@lock/utils';

export const badgeClass = (active: boolean): string => clsx('badge', active && 'badge--active');
export const fadeMillis = (): number => toMillis('250ms');
