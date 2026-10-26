import { Modal } from '@barrel/ui';

export function renderDialog(message: string): string {
  return Modal(`<p>${message}</p>`);
}
