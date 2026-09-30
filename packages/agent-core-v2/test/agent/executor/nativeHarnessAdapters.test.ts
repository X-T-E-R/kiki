import { createHash } from 'node:crypto';

import type { AcpElicitationRequest } from '@kiki/acp-client';
import type { HostProcessServiceLike } from '@kiki/codex-client';
import { describe, expect, it, vi } from 'vitest';

import { acpFormFields, acpFormResponse } from '#/agent/execution/acpElicitation';
import { acquireHarnessMcp, codexHarnessMcpProcess } from '#/agent/execution/harnessMcpLease';
import type { HarnessMcpLease } from '#/app/agentExecutor/harnessMcp';
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
    await expect(acquireHarnessMcp({ ...context, agent: { ...context.agent, id: 'child' }, binding: { ...context.binding, allowKikiSubagents: true } }, '/workspace')).rejects.toThrow('main profile');
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
