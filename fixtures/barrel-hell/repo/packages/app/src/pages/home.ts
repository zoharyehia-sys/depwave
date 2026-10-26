import { Button, Card } from '@barrel/ui';

export function renderHome(): string {
  return Card('Welcome', 'Get started') + Button('Sign in');
}
