import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';

const SUMMARY = 'Result summary for the delegated task with enough detail to match real receipts. '.repeat(18);
const PROMPT = 'Message from agent "main": inspect the module, report findings, and keep the answer short. '.repeat(10);

function resumeRecord(operationId: string, turnId: number): string {
  return JSON.stringify({
    operationId,
    fingerprint: 'f'.repeat(64),
    request: { kind: 'mailbox', prompt: PROMPT, message: { id: operationId } },
    state: 'started',
    switchInput: { operationId, model: 'stub', thinking: 'high', mode: 'direct' },
    turnId,
  });
}

/** Builds a synthetic session document with the same size profile as a long real session (about 7 MiB, mostly receipts and resume labels). */
export function longSessionMeta(sessionId: string, cwd: string, agentDir: string, agentCount: number): Record<string, unknown> {
  const now = Date.now();
  const agents: Record<string, unknown> = {};
  const mainLabels: Record<string, string> = { contextWindowEpoch: '1' };
  for (let i = 0; i < 468; i += 1) mainLabels[`dispatchResume:main-${String(i)}`] = resumeRecord(`main-${String(i)}`, i);
  agents['main'] = { createdAt: now - 1e7, homedir: join(agentDir, 'main'), type: 'main', labels: mainLabels, displayName: 'agent', model: 'stub', executor: 'native', executorProtocol: 'native' };
  for (let i = 1; i < agentCount; i += 1) {
    const id = `agent-${String(i)}`;
    const labels: Record<string, string> = { parentAgentId: 'main', requestIdentityRootAgent: 'main', requestIdentityParentTurn: String(i) };
    for (let r = 0; r < (i % 3 === 0 ? 2 : 1); r += 1) labels[`dispatchResume:${id}-${String(r)}`] = resumeRecord(`${id}-${String(r)}`, r);
    agents[id] = {
      createdAt: now - 1e7 + i, homedir: join(agentDir, id), type: 'sub', parentAgentId: 'main',
      delegator: { kind: 'agent', agentId: 'main' }, labels, displayName: 'explore', userLabel: `task ${String(i)}`,
      model: 'stub', executor: 'native', executorProtocol: 'native', status: i % 13 === 0 ? 'failed' : 'completed',
      completedAt: now - 1e6 + i, resultSummary: SUMMARY.slice(0, 1400), taskId: `task-${String(i)}`,
      usage: { inputOther: 1000 + i, output: 200, inputCacheRead: 5000 }, contextTokens: 4000 + i, toolCallCount: 7,
    };
  }
  return {
    id: sessionId, version: 2, cwd, delivery: 'reply', archived: false, custom: { cwd },
    title: 'perf long session', titleKind: 'custom', isCustomTitle: true,
    createdAt: now - 1e7, updatedAt: now - 1e6, activityUpdatedAt: now - 1e6, agents,
  };
}

function turnLines(turnId: number, text: string): string {
  const step = `step-${String(turnId)}`;
  const time = 1_790_000_000_000 + turnId * 1000;
  return `${[
    { type: 'turn.prompt', turnId, promptId: `prompt-${String(turnId)}`, input: [{ type: 'text', text: `question ${String(turnId)}` }], origin: { kind: 'user' }, time: time + 1 },
    { type: 'context.append_loop_event', event: { type: 'step.begin', turnId, step: 1, uuid: step }, time: time + 2 },
    { type: 'context.append_loop_event', event: { type: 'content.part', turnId, stepUuid: step, uuid: `part-${String(turnId)}`, part: { type: 'text', text } }, time: time + 3 },
    { type: 'context.append_loop_event', event: { type: 'step.end', turnId, step: 1, uuid: step }, time: time + 4 },
    { type: 'turn.ended', turnId, reason: 'completed', time: time + 5 },
  ].map((record) => JSON.stringify(record)).join('\n')}\n`;
}

/** Writes a wire journal of roughly `bytes` made of completed text turns. */
export async function writeLongWire(path: string, bytes: number): Promise<void> {
  const stream = createWriteStream(path);
  const text = 'x'.repeat(2048);
  let written = 0;
  let turnId = 0;
  const write = async (chunk: string): Promise<void> => { if (!stream.write(chunk)) await once(stream, 'drain'); written += chunk.length; };
  await write(`${JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: 1_790_000_000_000 })}\n`);
  while (written < bytes) {
    let batch = '';
    for (let i = 0; i < 256; i += 1) batch += turnLines(turnId++, text);
    await write(batch);
  }
  stream.end();
  await once(stream, 'finish');
}

/** Writes a long session's metadata, a large main wire and one small wire per subagent. */
export async function seedLongSession(sessionDir: string, sessionId: string, cwd: string, agentCount: number, wireBytes: number): Promise<void> {
  const agentDir = join(sessionDir, 'agents');
  await mkdir(join(agentDir, 'main'), { recursive: true });
  await writeLongWire(join(agentDir, 'main', 'wire.jsonl'), wireBytes);
  const small = `${JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: 1_790_000_000_000 })}\n${turnLines(0, 'done')}`;
  for (let i = 1; i < agentCount; i += 1) {
    const dir = join(agentDir, `agent-${String(i)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'wire.jsonl'), small);
  }
  await writeFile(join(sessionDir, 'state.json'), JSON.stringify(longSessionMeta(sessionId, cwd, agentDir, agentCount)));
}

/** Writes a JSONL file of about `bytes` and returns its line count. */
export async function writeBigFile(path: string, bytes: number): Promise<number> {
  const line = `${JSON.stringify({ type: 'record', payload: 'y'.repeat(1500) })}\n`;
  const lines = Math.ceil(bytes / line.length);
  const stream = createWriteStream(path);
  const block = line.repeat(1000);
  for (let i = 0; i < lines; i += 1000) if (!stream.write(i + 1000 <= lines ? block : line.repeat(lines - i))) await once(stream, 'drain');
  stream.end();
  await once(stream, 'finish');
  return lines;
}
