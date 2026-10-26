// Fully dynamic: no static prefix, so the analyzer cannot know which module this loads.
export async function loadPlugin(name: string): Promise<unknown> {
  return import(name);
}
