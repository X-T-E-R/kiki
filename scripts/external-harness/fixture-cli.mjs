import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

async function invokeHook(payload, key = 'kiki-agy-steering-bridge', event = 'PostInvocation') {
  const hooks = JSON.parse(await readFile('.agents/hooks.json', 'utf8'));
  const definition = hooks[key]?.[event][0];
  if (!definition) throw Object.assign(Error('No owned hook'), { code: 'ENOENT' });
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
if (args[0] === 'models') {
  process.stdout.write('fixture-alpha-high       Fixture Alpha (High)\nfixture-beta-medium     Fixture Beta (Medium)\n');
  process.exit(0);
}
const model = args[args.indexOf('--model') + 1];
if (model === 'claude-opus-5-5-high' && args.includes('--effort')) {
  process.stderr.write('invalid model selection: --effort is not supported for model "claude-opus-5-5-high"\n');
  process.exit(1);
}
const agent = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined;
const { requestHookPermission } = await import('./agy-permission-hook.mjs');
for (const key of Object.keys(process.env).filter(key => key.startsWith('KIKI_AGY_MCP_') && process.env.AGY_FIXTURE_MCP_OFF !== '1')) {
  await requestHookPermission({ type: 'mcp_bootstrap', key });
  if (process.env.AGY_FIXTURE_MCP_OFF !== 'ready') await requestHookPermission({ type: 'mcp_ready', key });
}
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (!turns) process.stdout.write(JSON.stringify({ event: 'init', conversation_id: conversation,
    init: { model: args.includes('--model') ? model : undefined, agent, cwd: process.cwd(), permission_mode: 'request-review' } }) + '\n');
  turns++;
  if (input.message.content === 'command-guidance') {
    const output = await invokeHook({ conversationId: conversation, workspacePaths: [process.cwd()] }, 'kiki-agy-command-guidance', 'SessionStart');
    process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: JSON.stringify(output) } }) + '\n');
    continue;
  }
  if (input.message.content === 'hang') continue;
  if (input.message.content === 'tool-hang') {
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
      step_update: { step_type: 'tool', step_index: turns, tool_name: 'run_command', state: 'ACTIVE', tool_info: { parameters: { command: 'example' } } } }) + '\n');
    continue;
  }
  if (input.message.content === 'background-events') {
    const tool = (step_index, state, output) => ({ event: 'step_update', conversation_id: conversation,
      step_update: { step_type: 'tool', step_index, state, tool_name: 'run_command',
        tool_info: { parameters: { CommandLine: 'native-owned-background-command' }, output } } });
    for (const event of [tool(42, 'ACTIVE'), tool(52, 'ACTIVE'), tool(52, 'ERROR', 'native failure'),
      { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 197, state: 'DONE', text_delta: 'native final' } }]) {
      process.stdout.write(JSON.stringify(event) + '\n');
    }
    setTimeout(() => {
      process.stdout.write(JSON.stringify(tool(42, 'DONE', 'native output')) + '\n');
      process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: 'native final' } }) + '\n');
    }, 100);
    continue;
  }
  if (input.message.content === 'native-tools') {
    const textPath = resolve('native-text.txt');
    const imagePath = resolve('native-image.bin');
    const writePath = resolve('native-write.txt');
    const editPath = resolve('native-edit.txt');
    const commandPath = resolve('native-command.txt');
    const searchPath = resolve('native-search.txt');
    let nativeStep = 0;
    const tool = async (toolName, parameters, run) => {
      const stepIndex = turns * 100 + ++nativeStep;
      const base = { step_type: 'tool', step_index: stepIndex, tool_name: toolName, tool_info: { parameters } };
      process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
        step_update: { ...base, state: 'ACTIVE' } }) + '\n');
      try {
        const output = await run();
        process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
          step_update: { ...base, state: 'DONE', tool_info: { parameters, output } } }) + '\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation,
          step_update: { ...base, state: 'ERROR', tool_info: { parameters, error: error instanceof Error ? error.message : String(error) } } }) + '\n');
      }
    };
    await tool('read_file', { Path: textPath }, () => readFile(textPath, 'utf8'));
    await tool('read_file', { Path: imagePath }, () => readFile(imagePath));
    await tool('write_file', { Path: writePath, Content: 'native write\n' }, async () => {
      await writeFile(writePath, 'native write\n'); return 'written';
    });
    await tool('edit_file', { Path: editPath, Replace: 'before', With: 'after' }, async () => {
      const current = await readFile(editPath, 'utf8');
      await writeFile(editPath, current.replace('before', 'after')); return 'modified';
    });
    await tool('run_command', { CommandLine: `${process.execPath} -e native-command`, Cwd: process.cwd() }, async () => {
      await new Promise((done, reject) => {
        const child = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(commandPath)}, 'command output\\n')`], { cwd: process.cwd(), stdio: 'ignore' });
        child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(Error(`Command exited ${code}`)));
      });
      return 'command completed';
    });
    await tool('search', { Query: 'needle', Path: searchPath }, async () => {
      const lines = (await readFile(searchPath, 'utf8')).split(/\r?\n/u);
      return { matches: lines.flatMap((line, index) => line.includes('needle') ? [{ line: index + 1, text: line }] : []) };
    });
    await tool('manage_task', { Action: 'status', TaskId: 'native-fixture-task' }, () => ({ status: 'completed', taskId: 'native-fixture-task' }));
    process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS',
      response: 'native-tools-complete', num_turns: turns } }) + '\n');
    continue;
  }
  if (input.message.content === 'steer-loop') {
    const tool = { step_type: 'tool', step_index: turns, tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'example' } } };
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation, step_update: { ...tool, state: 'ACTIVE' } }) + '\n');
    process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: conversation, step_update: { ...tool, state: 'DONE', tool_info: { ...tool.tool_info, output: 'done' } } }) + '\n');
    let injected = [];
    for (let invocationNum = 1; invocationNum <= 200 && injected.length === 0; invocationNum++) {
      const output = await invokeHook({ conversationId: conversation, invocationNum, initialNumSteps: 1, workspacePaths: [process.cwd()] });
      injected = output.terminationBehavior === 'force_continue' ? output.injectSteps ?? [] : [];
      if (!injected.length) await new Promise(done => setTimeout(done, 25));
    }
    const response = `steered:${injected.map(step => step.userMessage).join('|')}`;
    process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: turns * 2, state: 'DONE', text_delta: response } }) + '\n');
    process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response, num_turns: turns } }) + '\n');
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
