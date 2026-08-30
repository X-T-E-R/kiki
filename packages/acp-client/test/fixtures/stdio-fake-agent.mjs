import { spawn } from 'node:child_process';
import readline from 'node:readline';

const scenario = process.argv[2] ?? 'default';
const sessionId = 'fake-session-1';
const pendingClientRequests = new Map();
let nextClientRequestId = 9000;
let activePromptId;
let grandchild;

const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'model-a',
    options: [
      { value: 'model-a', name: 'Model A' },
      { value: 'model-b', name: 'Model B' },
    ],
  },
  {
    id: 'thought',
    name: 'Thought level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function result(id, value) {
  send({ id, result: value });
}

function error(id, code, message) {
  send({ id, error: { code, message } });
}

function update(value) {
  send({ method: 'session/update', params: { sessionId, update: value } });
}

function requestClient(method, params) {
  const id = nextClientRequestId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject });
  });
}

function capabilities() {
  if (scenario === 'new-only') return {};
  if (scenario === 'load-only' || scenario === 'load-replay') return { loadSession: true };
  return {
    loadSession: true,
    sessionCapabilities: { resume: {} },
  };
}

async function handlePrompt(message) {
  activePromptId = message.id;
  if (scenario === 'crash-after-prompt') {
    process.stderr.write('crash after prompt accepted\n');
    process.exit(41);
  }
  if (scenario === 'malformed-ndjson') {
    process.stdout.write('{not-valid-json\n');
    return;
  }
  if (scenario === 'hang-prompt' || scenario === 'hang-cancel' || scenario === 'spawn-grandchild') {
    if (scenario === 'spawn-grandchild') {
      grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      process.stderr.write(`GRANDCHILD_PID=${grandchild.pid}\n`);
    }
    return;
  }

  update({
    sessionUpdate: 'agent_message_chunk',
    messageId: 'message-1',
    content: { type: 'text', text: 'hello from fake' },
  });
  if (scenario === 'full-flow') {
    update({
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'thought-1',
      content: { type: 'text', text: 'thinking' },
    });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Run fake tool',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'echo fake' },
    });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
    });
    const permission = await requestClient('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'tool-1', title: 'Run fake tool', status: 'pending' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    process.stderr.write(`PERMISSION=${JSON.stringify(permission)}\n`);
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: permission?.outcome?.outcome === 'selected' ? 'completed' : 'failed',
      rawOutput: { text: 'done' },
    });
    update({
      sessionUpdate: 'plan',
      entries: [{ content: 'ship it', priority: 'high', status: 'in_progress' }],
    });
    update({ sessionUpdate: 'usage_update', used: 12, size: 100 });
    update({ sessionUpdate: 'vendor_future_update', value: 1 });
  }
  result(message.id, { stopReason: 'end_turn' });
  activePromptId = undefined;
}

async function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    const pending = pendingClientRequests.get(message.id);
    if (pending !== undefined) {
      pendingClientRequests.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
    return;
  }

  if (message.method === 'initialize') {
    if (scenario === 'hang-initialize') return;
    result(message.id, {
      protocolVersion: 1,
      agentCapabilities: capabilities(),
      agentInfo: { name: 'spawnable-fake', version: '1.0.0' },
    });
    return;
  }
  if (message.method === 'session/new') {
    if (scenario === 'crash-before-prompt') {
      process.stderr.write('crash before prompt\n');
      process.exit(40);
    }
    result(message.id, { sessionId, configOptions });
    if (scenario === 'stderr-noise') process.stderr.write('stderr-only-noise\n');
    if (scenario === 'idle-exit') setTimeout(() => process.exit(0), 1_500);
    return;
  }
  if (message.method === 'session/resume') {
    if (scenario === 'resume-method-not-found' || scenario === 'resume-load-method-not-found') {
      error(message.id, -32601, 'Method not found: session/resume');
    } else if (scenario === 'resume-unknown-session') {
      error(message.id, -32002, 'unknown session');
    } else {
      result(message.id, { configOptions });
    }
    return;
  }
  if (message.method === 'session/load') {
    if (scenario === 'load-method-not-found' || scenario === 'resume-load-method-not-found') {
      error(message.id, -32601, 'Method not found: session/load');
      return;
    }
    if (scenario === 'load-replay') {
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'replay-1',
        content: { type: 'text', text: 'historical replay' },
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    result(message.id, { configOptions });
    return;
  }
  if (message.method === 'session/set_config_option') {
    const option = configOptions.find((candidate) => candidate.id === message.params.configId);
    if (option) option.currentValue = message.params.value;
    result(message.id, { configOptions });
    update({ sessionUpdate: 'config_option_update', configOptions });
    return;
  }
  if (message.method === 'session/set_mode') {
    result(message.id, {});
    return;
  }
  if (message.method === 'session/prompt') {
    await handlePrompt(message);
    return;
  }
  if (message.method === 'session/cancel') {
    if (
      scenario !== 'hang-cancel' &&
      scenario !== 'spawn-grandchild' &&
      activePromptId !== undefined
    ) {
      result(activePromptId, { stopReason: 'cancelled' });
      activePromptId = undefined;
    }
    return;
  }
  if (message.method === '$/cancel_request') return;
  if (message.id !== undefined) error(message.id, -32601, `Method not found: ${message.method}`);
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim().length === 0) return;
  void handle(JSON.parse(line));
});
input.on('close', () => {
  grandchild?.kill();
  process.exit(0);
});
