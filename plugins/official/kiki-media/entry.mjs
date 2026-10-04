import { readFile } from 'node:fs/promises';

export async function register(api) {
  const manifest = JSON.parse(await readFile(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));
  for (const definition of manifest['x-kiki'].tools) {
    api.registerTool(definition, async (input, context) => {
      if (definition.name === 'generate') {
        const key = { image: 'defaultImageProvider', video: 'defaultVideoProvider', tts: 'defaultTtsProvider' }[input.request?.kind];
        const provider = input.provider ?? (context.settings[key] || undefined);
        const job = await context.media.generate({ ...input, provider });
        return { output: JSON.stringify({ type: 'media_generation', job }), isError: ['failed', 'unknown'].includes(job.state) };
      }
      const result = await context.media.media(input);
      return { output: JSON.stringify(result.job_id ? { type: 'media_generation', job: result } : result) };
    });
  }
}
