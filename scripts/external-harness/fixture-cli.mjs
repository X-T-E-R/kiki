import { createInterface } from 'node:readline';
let turns = 0;
const conversation = 'fixture-conversation';
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (!turns) process.stdout.write(JSON.stringify({ event: 'init', conversation_id: conversation,
    init: { model: args.includes('--model') ? model : undefined, cwd: process.cwd(), permission_mode: 'request-review' } }) + '\n');
  turns++;
  if (input.message.content === 'hang') continue;
  if (input.message.content === 'tool-hang') {
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
      step_update: { step_type: 'tool', step_index: turns, tool_name: 'run_command', state: 'ACTIVE', tool_info: { parameters: { command: 'example' } } } }) + '\n');
    continue;
  }
  if (input.message.content === 'malformed') { process.stdout.write('not-json\n'); continue; }
  if (input.message.content === 'crash') process.exit(0);
  const denied = input.message.content === 'deny';
  const deniedTool = input.message.content === 'deny-tool';
  if (denied || deniedTool) process.stderr.write('headless tool auto-denied\n');
  if (deniedTool) {
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
      step_update: { step_type: 'tool', step_index: turns, tool_name: 'run_command', state: 'ACTIVE', tool_info: { parameters: { command: 'example' } } } }) + '\n');
  }
  const response = `turn-${turns}`;
  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response',
    step_index: turns * 2, state: 'ACTIVE', text_delta: response.slice(0, 3) } }) + '\n');
  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response',
    step_index: turns * 2, state: 'DONE', text_delta: response.slice(3) } }) + '\n');
  process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS',
    response, num_turns: turns, denied_actions: denied || deniedTool ? [{ action: 'command' }] : undefined } }) + '\n');
}
