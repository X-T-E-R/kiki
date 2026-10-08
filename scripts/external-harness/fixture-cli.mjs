import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

async function invokeHook(payload) {
  const hooks = JSON.parse(await readFile('.agents/hooks.json', 'utf8'));
  const definition = hooks['kiki-agy-permission-bridge'].PreToolUse[0].hooks[0];
  const shell = process.platform === 'win32' ? process.env.ComSpec : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', definition.command] : ['-c', definition.command];
  const child = spawn(shell, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const exit = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(Error('Fixture hook failed'))); });
  child.stdin.end(JSON.stringify(payload));
  await exit;
  return JSON.parse(output);
}
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
  if (input.message.content.startsWith('vendor-')) {
    const write = input.message.content === 'vendor-write';
    const wide = input.message.content === 'vendor-command-wide';
    const command = 'echo approved> command-executed.txt';
    const path = resolve('fixture-report.md');
    const parameters = write ? { TargetFile: path, CodeContent: 'approved report' } : { CommandLine: command, Cwd: process.cwd() };
    const name = write ? 'write_to_file' : 'run_command';
    const resource = write ? `write_file(${path})` : `command(${command})`;
    const tool = { step_type: 'tool', step_index: turns, tool_name: name, tool_info: { parameters } };
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation, step_update: { ...tool, state: 'ACTIVE' } }) + '\n');
    let result = {};
    try { result = await invokeHook({ conversationId: conversation, stepIdx: turns, workspacePaths: [process.cwd()], toolCall: { name, args: parameters } }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Independent downstream resource check, not merely the hook's allow decision.
    // This models the documented override contract; installed CLI consumption is
    // established separately by the real consumer, not inferred from this fixture.
    const allowed = result.decision !== 'deny' && (wide || result.decision === 'allow' && result.permissionOverrides?.includes(resource));
    if (allowed) {
      if (write) await writeFile(path, parameters.CodeContent);
      else await new Promise((done, reject) => {
        const shell = process.platform === 'win32' ? process.env.ComSpec : '/bin/sh';
        const argv = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
        const child = spawn(shell, argv, { stdio: 'ignore' });
        child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(Error('Fixture command failed')));
      });
    }
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation, step_update: { ...tool, state: allowed ? 'DONE' : 'ERROR', tool_info: { parameters, output: allowed ? 'executed' : undefined, error: allowed ? undefined : 'Vendor resource permission denied' } } }) + '\n');
    process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: allowed ? 'resource-approved' : '', num_turns: turns, denied_actions: allowed ? undefined : [{ action: write ? 'write_file' : 'command' }] } }) + '\n');
    continue;
  }
  if (input.message.content.startsWith('hook-')) {
    const parameters = { CommandLine: 'Get-ChildItem -Path "C:/example/allowed" | Select-Object Name', Cwd: process.cwd() };
    const tool = { step_type: 'tool', step_index: turns, tool_name: 'run_command', tool_info: { parameters } };
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation, step_update: { ...tool, state: 'ACTIVE' } }) + '\n');
    const result = await invokeHook({ conversationId: conversation, stepIdx: turns, workspacePaths: [process.cwd()], toolCall: { name: 'run_command', args: parameters } });
    const allowed = result.decision === 'allow';
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
      step_update: { ...tool, state: allowed ? 'DONE' : 'ERROR', tool_info: { parameters, output: allowed ? 'directory result' : undefined, error: allowed ? undefined : result.reason } } }) + '\n');
    process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS',
      response: allowed ? 'hook-approved' : '', num_turns: turns, denied_actions: allowed ? undefined : [{ action: 'command', display_name: 'RunCommand' }] } }) + '\n');
    continue;
  }
  const denied = input.message.content === 'deny';
  const deniedTool = input.message.content === 'deny-tool';
  if (denied || deniedTool) process.stderr.write('headless tool auto-denied\n');
  if (deniedTool) {
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
      step_update: { step_type: 'tool', step_index: turns, tool_name: 'run_command', state: 'ACTIVE', tool_info: { parameters: { command: 'example' } } } }) + '\n');
  }
  if (input.message.content === 'missing-file' || input.message.content === 'unfinished-tool') {
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
      step_update: { step_type: 'tool', step_index: turns, tool_name: 'view_file', state: 'ACTIVE', tool_info: { parameters: { AbsolutePath: 'example-missing.txt' } } } }) + '\n');
    if (input.message.content === 'missing-file') process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
      step_update: { step_type: 'tool', step_index: turns, tool_name: 'view_file', state: 'ERROR', error: 'failed to read file: example-missing.txt: file does not exist' } }) + '\n');
  }
  const response = `turn-${turns}`;
  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response',
    step_index: turns * 2, state: 'ACTIVE', text_delta: response.slice(0, 3) } }) + '\n');
  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response',
    step_index: turns * 2, state: 'DONE', text_delta: response.slice(3) } }) + '\n');
  process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS',
    response, num_turns: turns, denied_actions: denied || deniedTool ? [{ action: 'command' }] : undefined } }) + '\n');
}
