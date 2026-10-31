import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IAgentContextMemoryService, IAgentLifecycleService, IAgentProfileService, IAgentTaskService,
  ISessionInteractionService, ISessionManager, ISubagentTool } from '@kiki/agent-core-v2';
import { prepareAgentReferences } from '@kiki/agent-core-v2/agent/prompt/agentReferences';
import { executeTool } from '../../agent-core-v2/test/tools/fixtures/execute-tool';
import { createKlient } from '@kiki/klient/http';
import { agentRefLink } from '@kiki/protocol';
import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const ids = ['codex-app-server', 'claude-acp', 'agy-cli', 'grok-acp'];

describe('native engine backend vertical fixtures', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  afterEach(async () => {
    await server?.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it.each(ids)('runs %s reference → AgentRun → native approval → result → same child continuation', { timeout: 60_000 }, async executor => {
    home = await mkdtemp(join(tmpdir(), 'kiki-native-fixture-'));
    const codex = executor === 'codex-app-server';
    const protocolFixture = new URL(codex ? '../../codex-client/test/fixtures/fake-app-server.mjs'
      : '../../acp-client/test/fixtures/stdio-fake-agent.mjs', import.meta.url);
    const script = join(home, 'protocol-fixture.mjs');
    await writeFile(script, `if (process.argv.includes('--version')) { console.log('protocol-fixture 1.0.0'); } else { process.argv[2] = ${JSON.stringify(codex ? 'approval' : 'full-flow')}; await import(${JSON.stringify(protocolFixture.href)}); }`);
    await writeFile(join(home, 'config.toml'), [
      '[search]', 'enabled = false', '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9"',
      '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
      `[agent_executors."${executor}"]`, `protocol = "${codex ? 'codex-app-server' : 'acp-v1'}"`,
      `args = ["${codex ? 'approval' : 'full-flow'}"]`,
      `sources = [{ id = "protocol-fixture", kind = "node-script", path = ${JSON.stringify(script)} }]`,
    ].join('\n'));
    await mkdir(join(home, 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'fixture-main.md'), ['---', 'name: fixture-main', 'description: Fixture coordinator',
      'main: true', 'model_alias: stub', 'tools: [AgentRun, TaskList, TaskOutput, TaskStop]',
      `allowed_subagents: ["engine:${executor}"]`, '---', 'Coordinate the fixture.'].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const base = `http://127.0.0.1:${server.port}`;
    const klient = createKlient({ endpoint: base, token: server.localOwnerToken });
    try {
      const created = await (await authedFetch(server, base, '/api/sessions', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'fixture-main' } }) })).json();
      expect(created.code, created.msg).toBe(0);
      const sessionId = created.data.id as string;
      const session = server.core.accessor.get(ISessionManager).get(sessionId)!;
      session.accessor.get(ISessionInteractionService).acquireConsumer('native-fixture');
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const main = lifecycle.get('main')!;
      const profile = `engine:${executor}`;
      const candidates = await klient.rest!.agents.referenceCandidates({ session_id: sessionId, agent_id: 'main' });
      expect(candidates.items).toEqual([expect.objectContaining({ profile, available: true, configuration: 'native' })]);
      const memory = main.accessor.get(IAgentContextMemoryService);
      const message = prepareAgentReferences({ id: 'fixture-message', role: 'user', content: [{ type: 'text', text: `Review with ${agentRefLink(profile)}` }],
        toolCalls: [], origin: { kind: 'user' } }, 'fixture-message', main.accessor);
      memory.appendObservable(message);
      expect(lifecycle.list()).toHaveLength(1);
      const ref = message.origin!.kind === 'user' ? message.origin!.agentRefs![0]! : undefined;
      expect(ref).toMatchObject({ profile, executor });
      const tasks = main.accessor.get(IAgentTaskService);
      await tasks.suppressAllTerminalNotifications();
      const tool = main.accessor.get(ISubagentTool);
      let outcome: unknown;
      const run = (resume?: string) => executeTool(tool, { turnId: 1, toolCallId: resume === undefined ? 'fixture-run' : 'fixture-resume',
        signal: new AbortController().signal, args: { prompt: 'Review this fixture without changing files.', description: 'Fixture native review',
          profile: resume === undefined ? profile : undefined, resume, name: resume === undefined ? 'native_fixture' : undefined,
          source_ref: ref!.refId, background: false } }).then(result => { outcome = result; return result; });
      const approve = async () => {
        await vi.waitFor(async () => expect((await klient.session(sessionId).approvals.list()).length,
          JSON.stringify({ outcome, tasks: tasks.list(false) })).toBe(1), { timeout: 15_000 });
        const approval = (await klient.session(sessionId).approvals.list())[0]!;
        await klient.session(sessionId).approvals.decide(approval.id!, { decision: 'approved', selectedOptionId: codex ? 'accept' : 'allow-once' });
      };
      const first = run();
      await approve();
      const result = await first;
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(JSON.stringify(result.output)).toContain(codex ? 'approved' : 'hello from fake');
      const child = lifecycle.list().find(agent => agent.id !== 'main')!;
      expect(child.accessor.get(IAgentProfileService).data()).toMatchObject({ executorId: executor,
        execution: { selection: { executor }, effective: { inject_kiki_mcp: undefined, allow_kiki_subagents: false } } });
      const taskId = /task_id: (\S+)/.exec(String(result.output))![1]!;
      const task = await tasks.getTaskSnapshot(taskId);
      expect(task).toMatchObject({ status: 'completed', agentId: child.id, sourceRef: { refId: ref!.refId, messageId: 'fixture-message', profile, executor } });
      expect(tasks.list(false)).toEqual([]);
      const continuation = run(child.id);
      await approve();
      const continued = await continuation;
      expect(continued.isError, JSON.stringify(continued)).not.toBe(true);
      const continuedTaskId = /task_id: (\S+)/.exec(String(continued.output))![1]!;
      expect(continuedTaskId).not.toBe(taskId);
      expect(await tasks.getTaskSnapshot(continuedTaskId)).toMatchObject({ status: 'completed', agentId: child.id,
        sourceRef: { refId: ref!.refId, messageId: 'fixture-message', profile, executor } });
      expect(lifecycle.list()).toHaveLength(2);
      expect(tasks.list(false)).toEqual([]);
      const direct = klient.session(sessionId).agent(child.id).prompt({ input: [{ type: 'text', text: 'Finish the direct follow-up.' }] }, { waitFor: 'terminal' });
      await approve();
      expect((await direct).state).toBe('completed');
      await vi.waitFor(() => expect(tasks.list(false)).toEqual([expect.objectContaining({ status: 'completed', agentId: child.id, detached: true })]));
    } finally { await klient.close(); }
  });
});
