import { createHash } from 'node:crypto';

import type { AcpElicitationRequest } from '@kiki/acp-client';
import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import type { HostProcessServiceLike } from '@kiki/codex-client';
import { describe, expect, it, vi } from 'vitest';

import { acpFormFields, acpFormResponse } from '#/agent/execution/acpElicitation';
import { acquireHarnessMcp, codexHarnessMcpProcess } from '#/agent/execution/harnessMcpLease';
import { resolveExecutionBinding } from '#/agent/profile/executionBinding';
import { BUILTIN_AGENT_EXECUTORS } from '#/app/agentExecutor/builtinDescriptorData';
import { kikiMcpDefaultView, kikiMcpSupport, nativeHarnessToolAllowed, type HarnessMcpLease } from '#/app/agentExecutor/harnessMcp';
import { externalAcpForkRecords } from '#/workspace/sessionLifecycle/internal/externalFork';
import { antigravityRelease } from '#/app/agentExecutor/antigravityDistribution';
import { agentExecutorBindingFingerprint, type AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import type { ProfileBindingSnapshot } from '#/agent/profile/profile';

const form: AcpElicitationRequest = {
  mode: 'form', sessionId: 'remote', message: 'Choose configuration', requestedSchema: {
    type: 'object', required: ['choice', 'enabled', 'count', 'tags'], properties: {
      choice: { type: 'string', title: 'Choice', oneOf: [{ const: 'a', title: 'Approach A' }, { const: 'b', title: 'Approach B' }] },
      enabled: { type: 'boolean', title: 'Enabled' },
      count: { type: 'integer', title: 'Count', minimum: 1, maximum: 5 },
      tags: { type: 'array', title: 'Tags', items: { enum: ['one', 'two'] } },
    },
  },
};

describe('external native harness adapters', () => {
  it('injects Codex MCP at process startup and keeps delegation credentials out of argv', async () => {
    let lease: HarnessMcpLease | undefined;
    const spawn = vi.fn(async (..._args: Parameters<HostProcessServiceLike['spawn']>) => { throw new Error('fixture-child'); });
    const wrapped = codexHarnessMcpProcess({ spawn }, () => lease);
    await expect(wrapped.spawn('codex', ['app-server'], { env: { BASE: 'keep' }, shell: false })).rejects.toThrow('fixture-child');
    expect(spawn.mock.calls[0]).toEqual(['codex', ['app-server'], { env: { BASE: 'keep' }, shell: false }]);
    lease = { server: { name: 'kiki-harness', command: 'kiki', args: ['mcp', '--workspace', '/workspace', '--attached'],
      env: [{ name: 'KIKI_DELEGATION_TOKEN', value: 'fixture-token' }, { name: 'KIKI_SESSION_ID', value: 'original' }] }, dispose: () => {} };
    await expect(wrapped.spawn('codex', ['app-server'], { env: { BASE: 'keep' }, shell: false })).rejects.toThrow('fixture-child');
    expect(spawn.mock.calls[1]).toEqual(['codex', ['app-server',
      '-c', 'mcp_servers.kiki-harness.command="kiki"',
      '-c', 'mcp_servers.kiki-harness.args=["mcp","--workspace","/workspace","--attached"]',
      '-c', 'mcp_servers.kiki-harness.env_vars=["KIKI_DELEGATION_TOKEN","KIKI_SESSION_ID"]',
      '-c', 'mcp_servers.kiki-harness.enabled=true', '-c', 'mcp_servers.kiki-harness.required=true',
    ], { env: { BASE: 'keep', KIKI_DELEGATION_TOKEN: 'fixture-token', KIKI_SESSION_ID: 'original' }, shell: false }]);
    expect(spawn.mock.calls[1]?.[1]?.join(' ')).not.toContain('fixture-token');
  });
  it('pre-approves only the Kiki MCP server when asked, never other servers or policies', async () => {
    const spawn = vi.fn(async (..._args: Parameters<HostProcessServiceLike['spawn']>) => { throw new Error('fixture-child'); });
    const lease: HarnessMcpLease = { server: { name: 'kiki-harness', command: 'kiki', args: [], env: [] }, dispose: () => {} };
    let approve = true;
    const wrapped = codexHarnessMcpProcess({ spawn }, () => lease, () => approve);
    await expect(wrapped.spawn('codex', ['app-server', '-c', 'mcp_servers.other.command="x"'])).rejects.toThrow('fixture-child');
    const args = spawn.mock.calls[0]![1]!;
    expect(args.filter((arg) => arg.includes('approval'))).toEqual(['mcp_servers.kiki-harness.default_tools_approval_mode="approve"']);
    approve = false;
    await expect(wrapped.spawn('codex', ['app-server'])).rejects.toThrow('fixture-child');
    expect(spawn.mock.calls[1]![1]!.some((arg) => arg.includes('approval'))).toBe(false);
  });
  it('preserves legacy local-resume fingerprints when delegation is omitted or explicitly disabled', () => {
    const binding: ProfileBindingSnapshot = { thinkingLevel: 'off', systemPrompt: 'Frozen profile' };
    const legacy = createHash('sha256').update(JSON.stringify({ thinkingLevel: 'off', systemPrompt: 'Frozen profile' })).digest('hex');
    expect(agentExecutorBindingFingerprint(binding)).toBe(legacy);
    expect(agentExecutorBindingFingerprint({ ...binding, allowKikiSubagents: false })).toBe(legacy);
    expect(agentExecutorBindingFingerprint({ ...binding, allowKikiSubagents: true })).not.toBe(legacy);
  });
  it('maps a complete ACP form into product questions and preserves typed wire values', () => {
    const fields = acpFormFields(form)!;
    expect(fields.map((field) => field.question.options.map((option) => option.label))).toEqual([
      ['Approach A', 'Approach B'], ['Yes', 'No'], [], ['one', 'two'],
    ]);
    expect(acpFormResponse(form, fields, { Choice: 'Approach B', Enabled: 'No', Count: '3', Tags: 'two, one' })).toEqual({
      action: 'accept', content: { choice: 'b', enabled: false, count: 3, tags: ['one', 'two'] },
    });
    expect(acpFormResponse(form, fields, { Choice: 'Approach B', Enabled: 'No', Count: 'NaN', Tags: 'one' })).toEqual({ action: 'decline' });
    expect(acpFormResponse(form, fields, { Choice: 'Approach B' })).toEqual({ action: 'decline' });
    expect(acpFormResponse(form, fields, null)).toEqual({ action: 'decline' });
  });

  it('declines unsupported/ambiguous forms rather than submitting a partial acceptance', () => {
    expect(acpFormFields({ ...form, requestedSchema: { type: 'object', properties: { secret: { type: 'object' } } } } as AcpElicitationRequest)).toBeUndefined();
    expect(acpFormFields({ ...form, requestedSchema: { type: 'object', properties: {
      first: { type: 'string', title: 'Same' }, second: { type: 'string', title: 'Same' },
    } } })).toBeUndefined();
  });

  it('does not expose secret or synthetic other-answer fields as unmasked ordinary questions', () => {
    for (const meta of [{ isSecret: true }, { isOtherAnswer: true }]) {
      expect(acpFormFields({ ...form, requestedSchema: { type: 'object', properties: {
        private: { type: 'string', _meta: { codex: meta } },
      } } } as AcpElicitationRequest)).toBeUndefined();
    }
  });

  it('marks copied ACP references for an exact AIR fork and counts repeated assistant text only', () => {
    const text = 'Same response';
    const records = [
      { type: 'executor.session.updated', executorId: 'codex-acp', sessionEpoch: 1, sessionRef: { executorId: 'codex-acp', version: 1, ref: { sessionId: 'original' } } },
      { type: 'context.append_message', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text }] } },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text }] } },
      { type: 'context.append_message', message: { role: 'assistant', id: 'a2', content: [{ type: 'text', text }] } },
    ];
    const result = externalAcpForkRecords(records, () => true, false);
    expect(result.at(-1)).toMatchObject({ sessionRef: { ref: { sessionId: 'original', kikiFork: {
      handoff: false, point: { version: 1, messageId: 'a2', messageFingerprint: `sha256:${createHash('sha256').update(text).digest('hex')}`, messageOccurrence: 2 },
    } } } });
    expect(records[0]!.sessionRef!.ref).toEqual({ sessionId: 'original' });
    expect(externalAcpForkRecords(records, () => true, true).at(-1)).toMatchObject({ sessionRef: { ref: { kikiFork: { handoff: true } } } });
    expect(externalAcpForkRecords(records, () => false, false)).toBe(records);
  });

  it('derives a historical fork fingerprint from the actual external recorder loop-event journal', () => {
    const records = [
      { type: 'executor.session.updated', executorId: 'claude-acp', sessionEpoch: 1, sessionRef: { executorId: 'claude-acp', version: 1, ref: { sessionId: 'original' } } },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'remote:1', turnId: '1', step: 1 } },
      { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'remote:1', uuid: 'remote:part:0', part: { type: 'text', text: 'First ' } } },
      { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'remote:1', uuid: 'remote:part:1', part: { type: 'think', think: 'private thought' } } },
      { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'remote:1', uuid: 'remote:part:2', part: { type: 'text', text: 'answer' } } },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'remote:1', finishReason: 'end_turn' } },
    ];
    expect(externalAcpForkRecords(records, () => true, false).at(-1)).toMatchObject({ sessionRef: { ref: { kikiFork: {
      handoff: false, point: { messageFingerprint: `sha256:${createHash('sha256').update('First answer').digest('hex')}`, messageOccurrence: 1 },
    } } } });
  });

  it('does not acquire a delegation seat by default and rejects unsupported transports before touching services', async () => {
    const context = { agent: { id: 'main', accessor: { get: () => { throw new Error('unexpected service'); } } },
      binding: {}, descriptor: { id: 'fixture', mcpTransports: ['http'] } } as unknown as AgentExecutorContext;
    expect(await acquireHarnessMcp(context, '/workspace')).toBeUndefined();
    await expect(acquireHarnessMcp({ ...context, binding: { ...context.binding, allowKikiSubagents: true } }, '/workspace')).rejects.toThrow('stdio MCP');
    await expect(acquireHarnessMcp({ ...context, agent: { ...context.agent, id: 'child' }, binding: { ...context.binding, allowKikiSubagents: true } }, '/workspace')).rejects.toThrow('stdio MCP');
  });

  it.each(['claude-acp', 'grok-acp'])('automatically leases %s native child tools without selecting a vendor agent', async (executorId) => {
    const acquire = vi.fn(async () => ({ server: { name: 'kiki-harness' }, dispose() {} }));
    const execution = resolveExecutionBinding({ executor: executorId }, undefined, undefined, undefined);
    const context = { agent: { id: 'child', accessor: { get: (id: unknown) =>
      String(id) === 'agentScopeContext' ? { parentAgentId: 'parent-fixture' }
        : String(id) === 'sessionContext' ? { sessionId: 'session-fixture' } : { acquire } } },
      binding: { execution }, descriptor: { id: executorId, ...BUILTIN_AGENT_EXECUTORS[executorId]! } } as unknown as AgentExecutorContext;
    expect(execution.effective.native_agent).toBeUndefined();
    expect(await acquireHarnessMcp(context, '/workspace')).toBeDefined();
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-fixture', agentId: 'child', nativeTools: true, executorId,
    }));
    const off = resolveExecutionBinding({ executor: executorId, overrides: { inject_kiki_mcp: false } }, undefined, undefined, execution);
    expect(await acquireHarnessMcp({ ...context, binding: { execution: off } }, '/workspace')).toBeUndefined();
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('automatically leases native tools for an MCP-compatible child under its exact identity', async () => {
    const acquire = vi.fn(async () => ({ server: { name: 'kiki-harness' }, dispose() {} }));
    const context = { agent: { id: 'child', accessor: { get: (id: unknown) =>
      String(id) === 'agentScopeContext' ? { parentAgentId: 'parent-fixture' }
        : String(id) === 'sessionContext' ? { sessionId: 'session-fixture' } : { acquire } } },
      binding: {}, descriptor: { id: 'fixture', supportsMcp: true } } as unknown as AgentExecutorContext;
    expect(await acquireHarnessMcp(context, '/workspace')).toBeDefined();
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-fixture', agentId: 'child', nativeTools: true, workspacePath: '/workspace',
    }));
    expect(await acquireHarnessMcp({ ...context, descriptor: { ...context.descriptor, supportsMcp: false } }, '/workspace')).toBeUndefined();
  });

  it('keeps bare main execution unchanged and acquires only requested main capabilities', async () => {
    const acquire = vi.fn(async () => ({ server: { name: 'kiki-harness' }, dispose() {} }));
    const execution = resolveExecutionBinding({ executor: 'fixture' }, undefined, undefined, undefined);
    const context = { agent: { id: 'not-a-child', accessor: { get: (id: unknown) =>
      String(id) === 'agentScopeContext' ? { parentAgentId: undefined }
        : String(id) === 'sessionContext' ? { sessionId: 'session-fixture' } : { acquire } } },
      binding: { execution, kikiContext: [], allowKikiSubagents: false },
      descriptor: { id: 'fixture', supportsMcp: true } } as unknown as AgentExecutorContext;
    expect(await acquireHarnessMcp(context, '/workspace')).toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
    for (const overrides of [{ allow_kiki_subagents: true }, { kiki_context: ['memory'] as const }]) {
      const requested = resolveExecutionBinding({ executor: 'fixture', overrides }, undefined, undefined, execution);
      expect(await acquireHarnessMcp({ ...context, binding: { ...context.binding, execution: requested } }, '/workspace')).toBeDefined();
    }
    expect(nativeHarnessToolAllowed({ kikiContext: ['memory'] }, undefined, 'MemoryRead', 'builtin')).toBe(true);
    expect(nativeHarnessToolAllowed({ kikiContext: ['memory'] }, undefined, 'Read', 'builtin')).toBe(false);
    expect(nativeHarnessToolAllowed({ allowKikiSubagents: true }, undefined, 'AgentRun', 'builtin')).toBe(true);
    expect(nativeHarnessToolAllowed({ allowKikiSubagents: true }, undefined, 'plugin_fixture', 'plugin')).toBe(false);
  });

  it('distinguishes normalized defaults from explicit capability off and unset inheritance', () => {
    const defaults = resolveExecutionBinding({ executor: 'fixture' }, undefined, undefined, undefined);
    const binding = { execution: defaults, kikiContext: [], allowKikiSubagents: false };
    for (const name of ['HistoryList', 'MemoryRead', 'AgentRun']) {
      expect(nativeHarnessToolAllowed(binding, 'parent', name, 'builtin')).toBe(true);
      expect(nativeHarnessToolAllowed(binding, undefined, name, 'builtin')).toBe(false);
    }
    const inherited = resolveExecutionBinding({ executor: 'fixture' }, {
      kiki_context: ['memory'], allow_kiki_subagents: true,
    }, undefined, undefined);
    const off = resolveExecutionBinding({ executor: 'fixture', overrides: {
      kiki_context: [], allow_kiki_subagents: false,
    } }, { kiki_context: ['memory'], allow_kiki_subagents: true }, undefined, inherited);
    for (const name of ['MemoryRead', 'HistoryList', 'AgentRun', 'AgentList', 'AgentSend']) {
      expect(nativeHarnessToolAllowed({ execution: off }, 'parent', name, 'builtin')).toBe(false);
    }
    for (const name of ['AgentNotify', 'Read', 'TaskList']) {
      expect(nativeHarnessToolAllowed({ execution: off }, 'parent', name, 'builtin')).toBe(true);
    }
    const restored = resolveExecutionBinding({ executor: 'fixture', overrides: {
      kiki_context: null, allow_kiki_subagents: null,
    } }, { kiki_context: ['memory'], allow_kiki_subagents: true }, undefined, off);
    expect(nativeHarnessToolAllowed({ execution: restored }, 'parent', 'MemoryRead', 'builtin')).toBe(true);
    expect(nativeHarnessToolAllowed({ execution: restored }, 'parent', 'AgentRun', 'builtin')).toBe(true);
    expect(nativeHarnessToolAllowed({ execution: restored }, 'parent', 'HistoryList', 'builtin')).toBe(false);
  });

  it('uses donor Antigravity release names and includes the required native sibling', () => {
    expect(antigravityRelease('1.2.1', 'win32', 'x64')).toMatchObject({
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-x86_64.zip',
      entry: 'agy_acp_server.exe', requiredSibling: 'localharness_external.exe', args: [],
    });
    expect(antigravityRelease('1.1.1', 'linux', 'arm64')).toMatchObject({
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip', args: ['--uid='],
    });
    expect(() => antigravityRelease('1.107.0-IDE', 'win32', 'ia32')).toThrow('platform');
    expect(() => antigravityRelease('2.0.0', 'win32', 'x64')).toThrow('1.x');
  });
});

describe('Kiki MCP injection switch', () => {
  const profile = { injectKikiMcp: true, kikiContext: ['memory'], executorPrompt: { delivery: 'preamble', include: ['memory_snapshot'] } } as unknown as AgentProfile;

  it('keeps session over profile over executor defaults, and an absent value on the current decision', () => {
    const absent = resolveExecutionBinding({ executor: 'fixture' }, undefined, undefined, undefined);
    expect(absent.effective.inject_kiki_mcp).toBeUndefined();
    expect(absent.sources['inject_kiki_mcp']).toBe('harness-default');
    expect(absent.effective.kiki_context).toEqual([]);
    const defaultsOff = resolveExecutionBinding({ executor: 'fixture' }, {
      inject_kiki_mcp: false, model_alias: 'fixture-model', thinking_effort: 'high', permission_mode: 'manual',
      kiki_context: ['memory'], executor_prompt: { include: ['memory_snapshot'] },
    }, undefined, undefined);
    expect(defaultsOff.effective).toMatchObject({
      inject_kiki_mcp: false, model: 'fixture-model', thinking: 'high', permission_mode: 'manual', kiki_context: ['memory'],
    });
    expect(defaultsOff.sources['inject_kiki_mcp']).toBe('harness-settings');
    const fromProfile = resolveExecutionBinding({ executor: 'fixture' }, { inject_kiki_mcp: false }, profile, defaultsOff);
    expect(fromProfile.effective.inject_kiki_mcp).toBe(true);
    expect(fromProfile.sources['inject_kiki_mcp']).toBe('profile');
    expect(fromProfile.effective.kiki_context).toEqual(['memory']);
    const fromSession = resolveExecutionBinding({ executor: 'fixture', overrides: { inject_kiki_mcp: false } },
      { inject_kiki_mcp: true }, profile, fromProfile);
    expect(fromSession.effective.inject_kiki_mcp).toBe(false);
    expect(fromSession.sources['inject_kiki_mcp']).toBe('session');
    expect(fromSession.effective.kiki_context).toEqual(['memory']);
    expect(fromSession.effective.allow_kiki_subagents).toBe(false);
    const cleared = resolveExecutionBinding({ executor: 'fixture', overrides: { inject_kiki_mcp: null } },
      { inject_kiki_mcp: false }, profile, fromSession);
    expect(cleared.effective.inject_kiki_mcp).toBe(true);
    expect(cleared.sources['inject_kiki_mcp']).toBe('profile');
    expect(cleared.effective.kiki_context).toEqual(['memory']);
  });

  it('snapshots a defaults change onto the next binding and leaves the held binding in place', () => {
    const held = resolveExecutionBinding({ executor: 'fixture' }, { inject_kiki_mcp: false, kiki_context: ['memory'] }, undefined, undefined);
    const next = resolveExecutionBinding({ executor: 'fixture' }, { inject_kiki_mcp: true, kiki_context: ['memory'] }, undefined, held);
    expect(held.effective.inject_kiki_mcp).toBe(false);
    expect(held.effective.kiki_context).toEqual(['memory']);
    expect(next.effective.inject_kiki_mcp).toBe(true);
    expect(next.generation).toBe(held.generation + 1);
  });

  it('does not lease when injection is explicitly off, and leases an explicit on through the existing tool gate', async () => {
    const acquire = vi.fn(async () => ({ server: { name: 'kiki-harness' }, dispose() {} }));
    const services = (parentAgentId: string | undefined) => (id: unknown) =>
      String(id) === 'agentScopeContext' ? { parentAgentId }
        : String(id) === 'sessionContext' ? { sessionId: 'session-fixture' } : { acquire };
    const off = resolveExecutionBinding({ executor: 'fixture', overrides: {
      inject_kiki_mcp: false, kiki_context: ['memory'], allow_kiki_subagents: true,
    } }, undefined, undefined, undefined);
    const offContext = { agent: { id: 'child', accessor: { get: services('parent-fixture') } },
      binding: { execution: off }, descriptor: { id: 'fixture', supportsMcp: true } } as unknown as AgentExecutorContext;
    expect(off.effective.kiki_context).toEqual(['memory']);
    expect(await acquireHarnessMcp(offContext, '/workspace')).toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
    expect(nativeHarnessToolAllowed({ execution: off }, 'parent-fixture', 'MemoryRead', 'builtin')).toBe(true);
    const on = resolveExecutionBinding({ executor: 'fixture' }, { inject_kiki_mcp: true }, undefined, undefined);
    const onContext = { agent: { id: 'main', accessor: { get: services(undefined) } },
      binding: { execution: on }, descriptor: { id: 'fixture', supportsMcp: true } } as unknown as AgentExecutorContext;
    expect(await acquireHarnessMcp(onContext, '/workspace')).toBeDefined();
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ nativeTools: true, hooks: undefined, agentId: 'main' }));
    expect(nativeHarnessToolAllowed({ execution: on }, undefined, 'MemoryRead', 'builtin')).toBe(false);
    expect(nativeHarnessToolAllowed({ execution: on }, undefined, 'AgentRun', 'builtin')).toBe(false);
    const refused = { agent: { id: 'main', accessor: { get: () => { throw new Error('unexpected service'); } } },
      binding: { execution: on }, descriptor: { id: 'openclaw-acp', supportsMcp: false } } as unknown as AgentExecutorContext;
    await expect(acquireHarnessMcp(refused, '/workspace')).rejects.toThrow('stdio MCP');
    const selectedOff = { ...refused, binding: { execution: off } } as unknown as AgentExecutorContext;
    expect(await acquireHarnessMcp(selectedOff, '/workspace')).toBeUndefined();
  });

  it('reports builtin bridge support from descriptor facts and does not treat an undeclared vendor as available', () => {
    const supportOf = (id: keyof typeof BUILTIN_AGENT_EXECUTORS) => kikiMcpSupport({ id, ...BUILTIN_AGENT_EXECUTORS[id]! });
    const supported = Object.keys(BUILTIN_AGENT_EXECUTORS).filter((id) => supportOf(id as keyof typeof BUILTIN_AGENT_EXECUTORS).state === 'supported').sort();
    expect(supported).toEqual(['agy-cli', 'antigravity-acp', 'claude-acp', 'codex-app-server', 'grok-acp', 'kimi-acp']);
    expect(supportOf('agy-cli').fact).toContain('supports_mcp is true');
    expect(supportOf('agy-cli').fact).toContain('stdio');
    expect(supportOf('codex-app-server').fact).toContain('process flags');
    expect(supportOf('openclaw-acp')).toMatchObject({ state: 'unsupported' });
    expect(supportOf('openclaw-acp').fact).toContain('mcpServers');
    expect(supportOf('pi-acp').fact).toContain('does not forward Kiki MCP servers');
    expect(supportOf('claude-acp').state).toBe('supported');
    expect(supportOf('gemini-acp').state).toBe('undeclared');
    expect(supportOf('deepseek-acp').state).toBe('undeclared');
    expect(kikiMcpSupport({ id: 'http-only', protocol: 'acp-v1', supportsMcp: true, mcpTransports: ['http'] })).toEqual({
      state: 'unsupported', fact: 'http-only mcp_transports is http; the Kiki bridge needs stdio.',
    });
    for (const id of Object.keys(BUILTIN_AGENT_EXECUTORS)) {
      const view = kikiMcpDefaultView(undefined, { id, ...BUILTIN_AGENT_EXECUTORS[id as keyof typeof BUILTIN_AGENT_EXECUTORS]! });
      expect(view.effective).toBeNull();
      expect(view).toMatchObject({ source: 'harness-default', applies: 'next_binding',
        precedence: ['session', 'profile', 'harness-settings', 'harness-default'] });
      expect(view.support.fact).not.toMatch(/token|api[_-]?key|secret|bearer/i);
    }
    expect(kikiMcpDefaultView(false, { id: 'agy-cli', ...BUILTIN_AGENT_EXECUTORS['agy-cli']! })).toMatchObject({
      effective: false, source: 'harness-settings', support: { state: 'supported' },
    });
  });
});
