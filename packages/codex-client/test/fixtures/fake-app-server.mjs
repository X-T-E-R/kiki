import readline from 'node:readline';

const mode = process.argv[2] ?? 'standard';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
let threadId = 'thread-1';
let turnId = 'turn-1';
let pendingTurn;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if ('jsonrpc' in message) process.exit(11);
    if (mode === 'hang-initialize') return;
    send({
      id: message.id,
      result: {
        userAgent: 'fake-codex/0.151.0',
        codexHome: process.cwd(),
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
        platformOs: process.platform,
      },
    });
    return;
  }
  if (message.method === 'initialized') {
    initialized = true;
    return;
  }
  if (!initialized) process.exit(12);
  if ('result' in message || 'error' in message) {
    if (mode === 'approval' && message.id === 41) {
      send({ id: pendingTurn.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'message-1', delta: 'approved' },
      });
      send({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } },
      });
    }
    return;
  }
  if (message.method === 'model/list') {
    if (mode === 'missing-model-list') {
      send({ id: message.id, result: {} });
      return;
    }
    send({
      id: message.id,
      result: {
        data: [{ id: 'gpt-test', model: 'gpt-test', displayName: 'Test', hidden: false }],
        nextCursor: null,
      },
    });
    return;
  }
  if (message.method === 'thread/start') {
    threadId = 'thread-new';
    send({ id: message.id, result: { thread: { id: threadId }, model: message.params.model } });
    return;
  }
  if (message.method === 'thread/resume') {
    if (mode === 'resume-protocol-error') {
      send({ id: message.id, error: { code: -32602, message: 'unknown thread' } });
      return;
    }
    if (mode === 'resume-crash') process.exit(7);
    threadId = message.params.threadId;
    send({ id: message.id, result: { thread: { id: threadId }, model: message.params.model } });
    return;
  }
  if (message.method === 'turn/start') {
    pendingTurn = message;
    turnId = 'turn-1';
    if (mode === 'approval') {
      send({
        id: 41,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId,
          turnId,
          itemId: 'command-1',
          startedAtMs: 1,
          command: 'echo fixture',
          availableDecisions: ['accept', 'decline', 'cancel'],
        },
      });
      return;
    }
    if (mode === 'malformed') {
      process.stdout.write('{broken json\n');
      return;
    }
    if (mode === 'crash') process.exit(9);
    if (mode === 'hang-turn') return;
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (mode === 'reasoning-stream') {
      send({
        method: 'item/reasoning/summaryTextDelta',
        params: { threadId, turnId, itemId: 'reasoning-1', delta: 'summary' },
      });
      send({
        method: 'item/reasoning/textDelta',
        params: { threadId, turnId, itemId: 'reasoning-1', delta: 'raw' },
      });
      send({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: { id: 'reasoning-1', type: 'reasoning', summary: ['summary'], content: ['raw'] },
          completedAtMs: 2,
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } },
      });
      return;
    }
    if (mode === 'reasoning-completed' || mode === 'reasoning-raw') {
      if (mode === 'reasoning-raw') {
        send({
          method: 'item/reasoning/textDelta',
          params: { threadId, turnId, itemId: 'reasoning-1', delta: 'raw' },
        });
      }
      send({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: { id: 'reasoning-1', type: 'reasoning', summary: ['summary'], content: ['raw'] },
          completedAtMs: 2,
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } },
      });
      return;
    }
    send({
      method: 'item/agentMessage/delta',
      params: { threadId, turnId, itemId: 'message-1', delta: 'hello' },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 1, outputTokens: 1 },
          last: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 1, outputTokens: 1 },
          modelContextWindow: 100,
        },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } },
    });
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } },
    });
    return;
  }
});
