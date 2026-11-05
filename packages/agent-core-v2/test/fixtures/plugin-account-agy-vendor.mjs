import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === 'models') {
  console.log('global-default-model');
} else {
  const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const conversation_id = flag('--conversation') ?? randomUUID();
  const model = flag('--model') ?? 'global-default-model';
  const settings = JSON.parse(flag('--settings') ?? '{}');
  const emit = (event, value) => console.log(JSON.stringify({ event, conversation_id, [event]: value }));
  emit('init', { cwd: process.cwd(), model });
  for await (const line of createInterface({ input: process.stdin })) {
    const text = JSON.parse(line).message.content;
    if (text === 'exit fixture') process.exit(9);
    let response = 'original AGY';
    if (settings.modelProvider === 'gemini') {
      const modelName = settings.customModelsConfig.customModels[model].modelName;
      const target = `${process.env.GOOGLE_GEMINI_BASE_URL}/v1beta/${modelName.replace('gemini-api://', '')}:streamGenerateContent?alt=sse`;
      const reply = await fetch(target, { method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ text, conversation_id, model, settings, proxy: process.env.HTTPS_PROXY }) });
      if (!reply.ok) {
        emit('result', { status: 'ERROR', conversation_id, error: await reply.text() });
        continue;
      }
      response = await reply.text();
    }
    emit('result', { status: 'SUCCESS', conversation_id, response });
  }
}
