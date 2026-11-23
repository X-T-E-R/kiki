import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ILogService } from '#/_base/log/log';
import type { ContentPart } from '#/kosong/contract/message';
import { triggerBlockingResults } from '#/features/externalHooks/app/externalHooksRunner';
import { parseClaudeHookGroups } from '#/features/externalHooks/internal/claudeHooks';
import { describe, expect, it, vi } from 'vitest';
import type { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import type { ISessionIndex } from '#/app/sessionIndex/sessionIndex';

import { makeHookRunner, nodeCommand } from './runner-stub';

describe('ExternalHooksRunnerService', () => {
  it('filters plugin hooks by canonical session workspace while keeping user and other-workspace hooks', async () => {
    let enabled = false;
    const lookup = vi.fn(async (id: string) => ({ workspaceId: id === 'session-a' ? 'workspace-a' : 'workspace-b' }));
    const runner = makeHookRunner([{ event: 'PreToolUse', command: nodeCommand('process.stdout.write("user");'), timeout: 5 }], {
      pluginHooks: [{ pluginId: 'example', event: 'PreToolUse', command: nodeCommand('process.stdout.write("plugin");'), timeout: 5 }],
      usage: { enabled: () => true, allows: async (workspaceId: string | undefined, pluginId: string) => pluginId !== 'example' || workspaceId !== 'workspace-a' || enabled } as unknown as IPluginUsageService,
      sessions: { get: lookup } as unknown as ISessionIndex,
    });
    try {
      expect((await runner.trigger('PreToolUse', { sessionId: 'session-a', cwd: realpathSync(tmpdir()) })).map((result) => result.stdout)).toEqual(['user']);
      expect((await runner.trigger('PreToolUse', { sessionId: 'session-b' })).map((result) => result.stdout)).toEqual(['user', 'plugin']);
      enabled = true;
      expect((await runner.trigger('PreToolUse', { sessionId: 'session-a' })).map((result) => result.stdout)).toEqual(['user', 'plugin']);
      expect(lookup).toHaveBeenCalledWith('session-a');
    } finally { await runner.dispose(); }
  });
  it('runs explicit v2 legacy commands with the old regex, deduplication and output contract', async () => {
    const command = nodeCommand('process.stdout.write("legacy"); process.exit(2);');
    const runner = makeHookRunner({ schemaVersion: 2, enabled: true, disabled: [], files: [], rules: [],
      legacy: [{ event: 'PreToolUse', matcher: 'Read|Write', command, timeout: 5 }, { event: 'PreToolUse', matcher: 'Read', command, timeout: 5 }],
    });
    const results = await runner.trigger('PreToolUse', { matcherValue: 'Read' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ action: 'block', stdout: 'legacy' });
    expect(await runner.trigger('PreToolUse', { matcherValue: 'Bash' })).toEqual([]);
  });
  it('fires a hook whose matcher regex matches the matcher value', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash|Write', command: nodeCommand('process.exit(0);'), timeout: 5 },
      { event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 },
      { event: 'Stop', matcher: '', command: nodeCommand('process.stdout.write("done");'), timeout: 5 },
    ]);

    const results = await runner.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('allow');
  });

  it('returns no results when no hook matcher matches the matcher value', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash|Write', command: nodeCommand('process.exit(0);'), timeout: 5 },
      { event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 },
    ]);

    const results = await runner.trigger('PreToolUse', { matcherValue: 'Grep', inputData: {} });
    expect(results).toHaveLength(0);
  });

  it('maps exit code 2 to a block action', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 },
    ]);

    const results = await runner.trigger('PreToolUse', { matcherValue: 'Read', inputData: {} });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
  });

  it('exposes a triggerBlock helper for block decisions', async () => {
    const runner = makeHookRunner([
      {
        event: 'PreToolUse',
        matcher: 'Read',
        command: nodeCommand('process.stderr.write("blocked"); process.exit(2);'),
        timeout: 5,
      },
    ]);

    await expect(
      runner.triggerBlock('PreToolUse', { matcherValue: 'Read', inputData: {} }),
    ).resolves.toEqual({ block: true, reason: 'blocked' });
  });

  it('fills a default triggerBlock reason when the hook result has none', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 },
    ]);

    await expect(
      runner.triggerBlock('PreToolUse', { matcherValue: 'Read', inputData: {} }),
    ).resolves.toEqual({ block: true, reason: 'Blocked by PreToolUse hook' });
  });

  it('blocks a running hook when the trigger signal aborts', async () => {
    const abortController = new AbortController();
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash', command: nodeCommand('setTimeout(() => {}, 10000);'), timeout: 5 },
    ]);
    const startedAt = Date.now();
    setTimeout(() => {
      abortController.abort();
    }, 50);

    const results = await runner.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: {},
      signal: abortController.signal,
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
    expect(results[0]?.timedOut).toBeUndefined();
  });

  it('serializes camelCase inputData as snake_case for hook stdin', async () => {
    const runner = makeHookRunner([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: nodeCommand([
          'let input = "";',
          'process.stdin.on("data", (chunk) => { input += chunk; });',
          'process.stdin.on("end", () => {',
          '  const parsed = JSON.parse(input);',
          '  process.stdout.write(String(parsed.tool_name) + " " + String(parsed.tool_call_id));',
          '});',
        ].join('\n')),
        timeout: 5,
      },
    ]);

    const results = await runner.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash', toolCallId: 'call_1' },
    });

    expect(results[0]?.stdout?.trim()).toBe('Bash call_1');
  });

  it('adds sessionId, cwd, and hookEventName from runner context', async () => {
    const runner = makeHookRunner(
      [
        {
          event: 'SessionStart',
          command: nodeCommand([
            'let input = "";',
            'process.stdin.on("data", (chunk) => { input += chunk; });',
            'process.stdin.on("end", () => {',
            '  const parsed = JSON.parse(input);',
            '  process.stdout.write(String(parsed.hook_event_name) + " " + String(parsed.session_id) + " " + String(parsed.cwd));',
            '});',
          ].join('\n')),
          timeout: 5,
        },
      ],
      { cwd: '/tmp' },
    );

    const results = await runner.trigger('SessionStart', { sessionId: 'ses_123' });
    expect(results[0]?.stdout?.trim()).toBe('SessionStart ses_123 /tmp');
  });

  it('runs hooks with per-hook cwd and env overrides', async () => {
    const runner = makeHookRunner(
      [
        {
          event: 'PreToolUse',
          command: nodeCommand('process.stdout.write(process.cwd() + " " + String(process.env.PLUGIN_HOOK_TEST));'),
          timeout: 5,
          cwd: realpathSync(tmpdir()),
          env: { PLUGIN_HOOK_TEST: 'plugin-env' },
        },
      ],
      { cwd: '/var/tmp' },
    );

    const results = await runner.trigger('PreToolUse', { matcherValue: '', inputData: {} });
    expect(results[0]?.stdout?.trim()).toBe(`${realpathSync(tmpdir())} plugin-env`);
  });

  it('treats an empty matcher string as a catch-all for any matcher value', async () => {
    const runner = makeHookRunner([
      { event: 'Stop', matcher: '', command: nodeCommand('process.stdout.write("done");'), timeout: 5 },
    ]);

    const results = await runner.trigger('Stop', { matcherValue: 'anything', inputData: {} });
    expect(results).toHaveLength(1);
  });

  it('matches ContentPart matcher values against their text content', async () => {
    const input = [
      { type: 'text', text: 'hello' },
      { type: 'image_url', imageUrl: { url: 'file:///tmp/a.png' } },
      { type: 'text', text: 'world' },
    ] satisfies readonly ContentPart[];
    const runner = makeHookRunner([
      { event: 'UserPromptSubmit', matcher: 'hello world', command: nodeCommand('process.exit(0);'), timeout: 5 },
    ]);

    const results = await runner.trigger('UserPromptSubmit', { matcherValue: input, inputData: {} });
    expect(results).toHaveLength(1);
  });

  it('returns no results for events that have no registered hooks', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo 1' },
    ]);

    const results = await runner.trigger('UserPromptSubmit', { matcherValue: '', inputData: {} });
    expect(results).toHaveLength(0);
  });

  it('dedupes hooks with identical command strings so they only fire once', async () => {
    const command = nodeCommand('process.stdout.write("once");');
    const runner = makeHookRunner([
      { event: 'Stop', command, timeout: 5 },
      { event: 'Stop', command, timeout: 5 },
    ]);

    const results = await runner.trigger('Stop', { inputData: {} });
    expect(results).toHaveLength(1);
  });

  it('does not dedupe hooks that share a command but have different cwd', async () => {
    const command = nodeCommand('process.stdout.write(process.cwd() + "\\n");');
    const runner = makeHookRunner([
      { event: 'Stop', command, timeout: 5, cwd: process.cwd() },
      { event: 'Stop', command, timeout: 5, cwd: tmpdir() },
    ]);

    const results = await runner.trigger('Stop', { inputData: {} });
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.stdout?.replace(/\r\n/g, '\n').trim()))).toEqual(
      new Set([realpathSync(process.cwd()), realpathSync(tmpdir())]),
    );
  });

  it('skips only the hook with an invalid matcher regex while keeping valid sibling hooks active', async () => {
    const warn = vi.fn();
    const runner = makeHookRunner(
      [
        { event: 'PreToolUse', matcher: '[invalid', command: nodeCommand('process.exit(2);'), timeout: 5 },
        { event: 'PreToolUse', matcher: 'Bash', command: nodeCommand('process.stdout.write("healthy");'), timeout: 5 },
      ],
      { log: { warn } as unknown as ILogService },
    );

    const results = await triggerBlockingResults(runner, 'PreToolUse', { matcherValue: 'Bash', inputData: {} });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ action: 'allow', stdout: 'healthy' });
    expect(warn).toHaveBeenCalledWith(
      'Skipping hook with invalid matcher',
      expect.objectContaining({ event: 'PreToolUse', matcher: '[invalid' }),
    );
  });

  it('fails open with a warning when the initial hook load fails', async () => {
    const warn = vi.fn();
    const runner = makeHookRunner([], {
      loadError: new Error('load failed'),
      log: { warn } as unknown as ILogService,
    });

    await expect(runner.triggerBlock('PreToolUse')).resolves.toBeUndefined();
    await expect(triggerBlockingResults(runner, 'UserPromptSubmit')).resolves.toEqual([]);
    await expect(runner.fireAndForgetTrigger('Notification')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'PreToolUse hook evaluation failed; failing open',
      expect.objectContaining({ event: 'PreToolUse', error: 'load failed' }),
    );
  });

  it('fails open on input preparation errors by default and fails closed when failClosed is configured', async () => {
    const inputData = {};
    Object.defineProperty(inputData, 'broken', {
      enumerable: true,
      get() {
        throw new Error('broken input');
      },
    });
    const warn = vi.fn();
    const defaultRunner = makeHookRunner(
      [{ event: 'PreToolUse', matcher: 'Bash', command: nodeCommand('process.stdout.write("should-not-run");') }],
      { log: { warn } as unknown as ILogService },
    );

    await expect(defaultRunner.trigger('PreToolUse', { matcherValue: 'Bash', inputData })).resolves.toEqual([]);
    await expect(defaultRunner.triggerBlock('PreToolUse', { matcherValue: 'Bash', inputData })).resolves.toBeUndefined();
    await expect(triggerBlockingResults(defaultRunner, 'UserPromptSubmit', { matcherValue: 'prompt', inputData })).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'PreToolUse hook evaluation failed; failing open',
      expect.objectContaining({ event: 'PreToolUse', error: 'broken input' }),
    );

    const strictRunner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash', command: nodeCommand('process.stdout.write("should-not-run");'), failClosed: true },
      { event: 'UserPromptSubmit', command: nodeCommand('process.stdout.write("should-not-run");'), failClosed: true },
    ]);
    await expect(strictRunner.triggerBlock('PreToolUse', { matcherValue: 'Bash', inputData })).resolves.toEqual({
      block: true,
      reason: 'Failed to evaluate PreToolUse hooks: broken input',
    });
    await expect(
      triggerBlockingResults(strictRunner, 'UserPromptSubmit', { matcherValue: 'prompt', inputData }),
    ).resolves.toEqual([
      { action: 'block', failClosed: true, reason: 'Failed to evaluate UserPromptSubmit hooks: broken input' },
    ]);
  });

  it('fails open with warnings for PreToolUse and UserPromptSubmit hook faults unless failClosed is set or block is explicit', async () => {
    const warn = vi.fn();
    const runner = makeHookRunner(
      [
        { event: 'PreToolUse', matcher: 'CrashTool', command: nodeCommand('process.stderr.write("boom"); process.exit(1);'), timeout: 5 },
        { event: 'PreToolUse', matcher: 'MissingBinTool', command: nodeCommand('process.exit(127);'), timeout: 5 },
        { event: 'PreToolUse', matcher: 'SlowTool', command: nodeCommand('setTimeout(() => {}, 10000);'), timeout: 0.05 },
        { event: 'PreToolUse', matcher: 'BadJsonTool', command: nodeCommand('process.stdout.write("{\\"hookSpecificOutput\\":");'), timeout: 5 },
        { event: 'PreToolUse', matcher: 'StrictCrashTool', command: nodeCommand('process.stderr.write("strict failure"); process.exit(1);'), timeout: 5, failClosed: true },
        { event: 'PreToolUse', matcher: 'StrictSlowTool', command: nodeCommand('setTimeout(() => {}, 10000);'), timeout: 0.05, failClosed: true },
        { event: 'PreToolUse', matcher: 'StrictBadJsonTool', command: nodeCommand('process.stdout.write("{\\"hookSpecificOutput\\":");'), timeout: 5, failClosed: true },
        { event: 'PreToolUse', matcher: 'ExplicitDenyJsonTool', command: nodeCommand('process.stdout.write(JSON.stringify({ decision: "block", reason: "top-level deny" }));'), timeout: 5 },
        { event: 'UserPromptSubmit', matcher: 'crash', command: nodeCommand('process.exit(1);'), timeout: 5 },
        { event: 'UserPromptSubmit', matcher: 'missing', command: nodeCommand('process.exit(127);'), timeout: 5 },
        { event: 'UserPromptSubmit', matcher: 'slow', command: nodeCommand('setTimeout(() => {}, 10000);'), timeout: 0.05 },
        { event: 'UserPromptSubmit', matcher: 'badjson', command: nodeCommand('process.stdout.write("{\\"decision\\":");'), timeout: 5 },
        { event: 'UserPromptSubmit', matcher: 'strict', command: nodeCommand('process.stderr.write("guard required"); process.exit(1);'), timeout: 5, failClosed: true },
      ],
      { log: { warn } as unknown as ILogService },
    );
    try {
      await expect(runner.triggerBlock('PreToolUse', { matcherValue: 'CrashTool' })).resolves.toBeUndefined();
      await expect(runner.triggerBlock('PreToolUse', { matcherValue: 'MissingBinTool' })).resolves.toBeUndefined();
      await expect(runner.triggerBlock('PreToolUse', { matcherValue: 'SlowTool' })).resolves.toBeUndefined();
      await expect(runner.triggerBlock('PreToolUse', { matcherValue: 'BadJsonTool' })).resolves.toBeUndefined();
      await expect(runner.triggerBlock('UserPromptSubmit', { matcherValue: 'crash' })).resolves.toBeUndefined();
      await expect(runner.triggerBlock('UserPromptSubmit', { matcherValue: 'missing' })).resolves.toBeUndefined();
      await expect(runner.triggerBlock('UserPromptSubmit', { matcherValue: 'slow' })).resolves.toBeUndefined();
      await expect(runner.triggerBlock('UserPromptSubmit', { matcherValue: 'badjson' })).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith('PreToolUse hook failed; failing open', expect.objectContaining({ event: 'PreToolUse', exitCode: 1 }));
      expect(warn).toHaveBeenCalledWith('PreToolUse hook failed; failing open', expect.objectContaining({ event: 'PreToolUse', exitCode: 127 }));
      expect(warn).toHaveBeenCalledWith('PreToolUse hook failed; failing open', expect.objectContaining({ event: 'PreToolUse', timedOut: true }));
      expect(warn).toHaveBeenCalledWith('UserPromptSubmit hook failed; failing open', expect.objectContaining({ event: 'UserPromptSubmit', exitCode: 127 }));

      await expect(runner.triggerBlock('PreToolUse', { matcherValue: 'StrictCrashTool' })).resolves.toEqual({
        block: true,
        reason: 'strict failure',
      });
      await expect(runner.triggerBlock('PreToolUse', { matcherValue: 'StrictSlowTool' })).resolves.toEqual({
        block: true,
        reason: 'Blocked by PreToolUse hook',
      });
      await expect(runner.triggerBlock('PreToolUse', { matcherValue: 'StrictBadJsonTool' })).resolves.toEqual({
        block: true,
        reason: 'Hook produced invalid protocol JSON output',
      });
      await expect(runner.triggerBlock('PreToolUse', { matcherValue: 'ExplicitDenyJsonTool' })).resolves.toEqual({
        block: true,
        reason: 'top-level deny',
      });
      await expect(runner.triggerBlock('UserPromptSubmit', { matcherValue: 'strict' })).resolves.toEqual({
        block: true,
        reason: 'guard required',
      });
    } finally {
      await runner.dispose();
    }
  }, 15_000);

  it('parses failClosed and fail_closed in Claude hook groups', () => {
    const parsed = parseClaudeHookGroups({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'echo a', failClosed: true },
            { type: 'command', command: 'echo b', fail_closed: true },
          ],
        },
      ],
    });
    expect(parsed.unsupported).toEqual([]);
    expect(parsed.hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo a', failClosed: true },
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo b', failClosed: true },
    ]);
  });

  it('fails open when fireAndForgetTrigger sees a synchronous trigger error', async () => {
    const runner = makeHookRunner([]);
    vi.spyOn(runner, 'trigger').mockImplementation(() => {
      throw new Error('trigger failed');
    });

    await expect(runner.fireAndForgetTrigger('Notification')).resolves.toEqual([]);
  });

  it('invokes onTriggered with (event,target,count) and onResolved with (event,target,action)', async () => {
    const triggered: Array<[string, string, number]> = [];
    const resolved: Array<[string, string, string]> = [];
    const runner = makeHookRunner(
      [{ event: 'PreToolUse', matcher: 'Bash', command: nodeCommand('process.exit(0);'), timeout: 5 }],
      {
        onTriggered: (event, target, count) => triggered.push([event, target, count]),
        onResolved: (event, target, action) => resolved.push([event, target, action]),
      },
    );

    await runner.trigger('PreToolUse', { matcherValue: 'Bash', inputData: {} });

    expect(triggered).toEqual([['PreToolUse', 'Bash', 1]]);
    expect(resolved).toEqual([['PreToolUse', 'Bash', 'allow']]);
  });

  it('preserves a block result even when lifecycle callbacks throw', async () => {
    const runner = makeHookRunner(
      [{ event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 }],
      {
        onTriggered: () => {
          throw new Error('trigger telemetry failed');
        },
        onResolved: () => {
          throw new Error('resolve telemetry failed');
        },
      },
    );

    const results = await runner.trigger('PreToolUse', { matcherValue: 'Read', inputData: {} });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
  });

  it('injects the bootstrap client platform as client_type into every payload', async () => {
    const runner = makeHookRunner([
      {
        event: 'SessionStart',
        command: nodeCommand([
          'let input = "";',
          'process.stdin.on("data", (chunk) => { input += chunk; });',
          'process.stdin.on("end", () => {',
          '  process.stdout.write(String(JSON.parse(input).client_type));',
          '});',
        ].join('\n')),
        timeout: 5,
      },
    ]);

    const results = await runner.trigger('SessionStart', { inputData: {} });
    expect(results[0]?.stdout?.trim()).toBe('test_platform');
  });

  it('lets the caller override clientType in inputData', async () => {
    const runner = makeHookRunner([
      {
        event: 'SessionStart',
        command: nodeCommand([
          'let input = "";',
          'process.stdin.on("data", (chunk) => { input += chunk; });',
          'process.stdin.on("end", () => {',
          '  process.stdout.write(String(JSON.parse(input).client_type));',
          '});',
        ].join('\n')),
        timeout: 5,
      },
    ]);

    const results = await runner.trigger('SessionStart', {
      inputData: { clientType: 'custom_client' },
    });
    expect(results[0]?.stdout?.trim()).toBe('custom_client');
  });

  it('reports hook presence through hasHooksFor', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo 1' },
      { event: 'SessionHeartbeat', command: 'echo 2' },
    ]);

    await runner.ready;
    expect(runner.hasHooksFor('PreToolUse')).toBe(true);
    expect(runner.hasHooksFor('SessionHeartbeat')).toBe(true);
    expect(runner.hasHooksFor('Stop')).toBe(false);
  });

  it('isolates broken hook plugins without locking sessions while preserving load diagnostics and logging once on load', async () => {
    const warn = vi.fn();
    const sessionWorkspaces: Record<string, string> = {
      'session-prod': 'workspace-prod',
      'session-lab': 'workspace-lab',
      'session-lab-safe': 'workspace-lab',
    };
    const runner = makeHookRunner(
      [{ event: 'UserPromptSubmit', command: nodeCommand('process.stdout.write("user-ok");'), timeout: 5 }],
      {
        log: { warn } as unknown as ILogService,
        pluginHooks: [
          {
            pluginId: 'healthy-guard',
            event: 'UserPromptSubmit',
            command: nodeCommand('process.stdout.write("healthy-plugin-ok");'),
            timeout: 5,
          },
        ],
        pluginHookFailures: [
          {
            pluginId: 'broken-lab-guard',
            defaultEnabled: false,
            message: 'Invalid hook matcher "[unclosed"',
          },
        ],
        usage: {
          enabled: () => true,
          allows: async (workspaceId: string | undefined, pluginId: string, sessionId?: string) => {
            if (pluginId === 'healthy-guard') return true;
            if (pluginId === 'broken-lab-guard') {
              if (sessionId === 'session-lab-safe') return false;
              return workspaceId === 'workspace-lab';
            }
            return false;
          },
        } as unknown as IPluginUsageService,
        sessions: {
          get: async (id: string) => (sessionWorkspaces[id] === undefined ? undefined : { workspaceId: sessionWorkspaces[id] }),
        } as unknown as ISessionIndex,
      },
    );
    try {
      const prodResults = await triggerBlockingResults(runner, 'UserPromptSubmit', {
        sessionId: 'session-prod',
        matcherValue: 'hello',
      });
      expect(prodResults.map((item) => item.stdout)).toEqual(['user-ok', 'healthy-plugin-ok']);

      const safeLabResults = await triggerBlockingResults(runner, 'UserPromptSubmit', {
        sessionId: 'session-lab-safe',
        matcherValue: 'hello',
      });
      expect(safeLabResults.map((item) => item.stdout)).toEqual(['user-ok', 'healthy-plugin-ok']);

      const labResults = await triggerBlockingResults(runner, 'UserPromptSubmit', {
        sessionId: 'session-lab',
        matcherValue: 'hello',
      });
      expect(labResults.map((item) => item.stdout)).toEqual(['user-ok', 'healthy-plugin-ok']);
      await expect(
        runner.triggerBlock('UserPromptSubmit', { sessionId: 'session-lab', matcherValue: 'hello' }),
      ).resolves.toBeUndefined();

      expect(runner.hookLoadFailures).toEqual([
        {
          pluginId: 'broken-lab-guard',
          defaultEnabled: false,
          message: 'Invalid hook matcher "[unclosed"',
        },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Plugin failed to load one or more hooks; skipping failed hooks',
        expect.objectContaining({ pluginId: 'broken-lab-guard' }),
      );

      await expect(
        runner.fireAndForgetTrigger('Notification', { sessionId: 'session-lab' }),
      ).resolves.toEqual([]);
    } finally {
      await runner.dispose();
    }
  });
});
