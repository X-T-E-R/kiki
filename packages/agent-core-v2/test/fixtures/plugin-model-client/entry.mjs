import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));
export function register(api) {
  api.registerTool(manifest['x-kiki'].tools[0], async (args, context) => {
    const events = [];
    try {
      if (args.action === 'catalog') return { output: JSON.stringify({ pid: process.pid, catalog: await context.models.list(), credential: await context.credentials.status('credential') }) };
      if (args.action === 'credential') return { output: JSON.stringify(await context.credentials.set('credential', args.value)) };
      const local = new AbortController();
      for await (const event of context.models.stream(args.request, { signal: local.signal })) {
        events.push(event);
        if (event.type === 'delta') {
          context.progress({ kind: 'status', text: 'fixture model delta' });
          if (args.cancel) local.abort();
          if (args.stop) break;
        }
      }
      return { output: JSON.stringify({ events }) };
    } catch (error) {
      return { output: JSON.stringify({ events, error: { code: error.code, message: error.message } }), isError: true };
    }
  });
}
export async function handlePanelRequest(action, args, context) {
  if (action === 'credential') return context.credentials.set('credential', args.value);
  return { catalog: await context.models.list(), credential: await context.credentials.status('credential') };
}
