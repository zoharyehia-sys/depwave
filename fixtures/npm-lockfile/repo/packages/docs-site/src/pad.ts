import clsx from 'clsx';
import leftPad from 'left-pad';

export const lineNumber = (n: number): string => leftPad(String(n), 4);

export const lineClass = (n: number): string => clsx('line', n % 2 === 0 && 'line--even');
