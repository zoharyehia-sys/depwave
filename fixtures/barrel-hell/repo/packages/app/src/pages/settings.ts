import { Input, Select } from '@barrel/ui';

export function renderSettings(): string {
  return Input('email') + Select('theme', ['light', 'dark']);
}
