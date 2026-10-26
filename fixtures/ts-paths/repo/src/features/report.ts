import { isoDate } from '@lib/date';

export function reportTitle(d: Date): string {
  return `Report for ${isoDate(d)}`;
}
