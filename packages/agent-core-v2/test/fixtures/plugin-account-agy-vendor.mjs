import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

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
      const continuation = text.startsWith('The connection to the model provider was interrupted');
      let saved;
      if (continuation) {
        try { saved = JSON.parse(readFileSync('lease-failover-state.json', 'utf8')); } catch {}
      }
      if (text === 'lease failover fixture' || saved?.conversation_id === conversation_id) {
        if (!continuation) {
          writeFileSync('lease-failover-state.json', JSON.stringify({ conversation_id }));
          emit('step_update', { step_type: 'user_input', step_index: 10, state: 'DONE' });
          emit('step_update', { step_type: 'tool', step_index: 11, tool_name: 'run_command', state: 'ACTIVE' });
          appendFileSync('native-executions.txt', 'lease-tool\n');
          emit('step_update', { step_type: 'tool', step_index: 11, tool_name: 'run_command', state: 'DONE', tool_info: { output: 'lease-tool-executions=1' } });
        } else {
          emit('step_update', { step_type: 'user_input', step_index: 20, state: 'DONE' });
        }
        let reply;
        try {
          reply = await fetch(target, { method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
            body: JSON.stringify({ text, conversation_id, model, settings, proxy: process.env.HTTPS_PROXY }) });
        } catch {
          emit('step_update', { step_type: 'error_message', step_index: 12, state: 'DONE' });
          emit('result', { status: 'ERROR', conversation_id,
            error: 'read tcp 127.0.0.1: wsarecv: An existing connection was forcibly closed by the remote host.' });
          continue;
        }
        if (!reply.ok) {
          emit('result', { status: 'ERROR', conversation_id, error: await reply.text() });
          continue;
        }
        response = await reply.text();
        emit('step_update', { step_type: 'agent_response', step_index: 21, state: 'DONE', text_delta: response });
        emit('result', { status: 'SUCCESS', conversation_id, response });
        continue;
      }
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
