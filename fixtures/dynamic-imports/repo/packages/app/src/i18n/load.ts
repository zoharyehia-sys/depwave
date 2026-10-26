export async function loadMessages(locale: string): Promise<Record<string, string>> {
  const mod = await import(`./locales/${locale}.ts`);
  return mod.messages;
}
