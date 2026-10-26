import { Button } from './Button';

export function Card(title: string, action: string): string {
  return `<section><h2>${title}</h2>${Button(action)}</section>`;
}
