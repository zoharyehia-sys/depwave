export function Modal(body: string): string {
  // Rendered into the portal root by the host app.
  return `<dialog open>${body}</dialog>`;
}
