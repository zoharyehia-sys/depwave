import leftPad from 'left-pad';

export const lineNumber = (n: number): string => leftPad(String(n), 4);
