import { describe, expect, it } from 'vitest';

import { buildHookSpawnOptions, runHook } from '#/features/externalHooks/internal/runHook';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

const hostProcess = new HostProcessService();

function nodeCommand(source: string): string {
  return `node -e ${JSON.stringify(source.replace(/\s*\n\s*/g, ' '))}`;
}

describe('runHook process runner', () => {
  it('returns allow when the hook exits 0 and captures stdout', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("ok\\n");'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.stdout?.trim()).toBe('ok');
  });

  it('parses stdout JSON message into a hook result message', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ message: "hook says hi" }));'),
      {},
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBe('hook says hi');
    expect(result.structuredOutput).toBe(true);
  });

  it('distinguishes ordinary JSON from an empty structured hook output', async () => {
    const emptyObject = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("{}");'),
      {},
      { timeout: 5 },
    );
    expect(emptyObject.action).toBe('allow');
    expect(emptyObject.message).toBeUndefined();
    expect(emptyObject.structuredOutput).toBeUndefined();

    const emptyHookSpecificOutput = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: {} }));'),
      {},
      { timeout: 5 },
    );
    expect(emptyHookSpecificOutput.action).toBe('allow');
    expect(emptyHookSpecificOutput.message).toBeUndefined();
    expect(emptyHookSpecificOutput.structuredOutput).toBe(true);
  });

  it('returns block when the hook exits 2 and captures stderr as the reason', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stderr.write("blocked\\n"); process.exit(2);'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toContain('blocked');
  });

  it('returns block on non-zero, non-2 exit codes', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.exit(1);'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.exitCode).toBe(1);
  });

  it('returns block with timedOut=true when the command exceeds the timeout', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('setTimeout(() => {}, 10000);'),
      { tool_name: 'Bash' },
      { timeout: 0.05 },
    );

    expect(result.action).toBe('block');
    expect(result.timedOut).toBe(true);
  });

  it('returns allow for ordinary bracket-prefixed logs', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("[INFO] validation passed");'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('returns allow for bracket-prefixed logs that mention a protocol field', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(\'[INFO] response contains "message": metadata\');'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('returns allow for ordinary plain-text logs', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("validation passed");'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('returns block when an explicit hook protocol object is malformed JSON', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(\'{"hookSpecificOutput":\');'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ['direct array entry', [{ hookSpecificOutput: { permissionDecision: 'deny' } }]],
    ['after a null entry', [null, { hookSpecificOutput: { permissionDecision: 'deny' } }]],
    ['inside a nested array', [[{ hookSpecificOutput: { permissionDecision: 'deny' } }]]],
  ])('returns block when a hook protocol decision appears in a parsed %s', async (_case, value) => {
    const output = JSON.stringify(value);
    const result = await runHook(
      hostProcess,
      nodeCommand(`process.stdout.write(${JSON.stringify(output)});`),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.exitCode).toBe(0);
  });

  it('returns block for Python dict-style hook protocol output', async () => {
    const output = "{'hookSpecificOutput': {'permissionDecision': 'deny'}}";
    const result = await runHook(
      hostProcess,
      nodeCommand(`process.stdout.write(${JSON.stringify(output)});`),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.exitCode).toBe(0);
  });

  it('returns block when a hook protocol field is missing its colon', async () => {
    const output = '{"hookSpecificOutput"}';
    const result = await runHook(
      hostProcess,
      nodeCommand(`process.stdout.write(${JSON.stringify(output)});`),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.exitCode).toBe(0);
  });

  it('returns block when a hook protocol field is missing its leading comma', async () => {
    const output = '{"x": 1 "hookSpecificOutput": {"permissionDecision": "deny"}}';
    const result = await runHook(
      hostProcess,
      nodeCommand(`process.stdout.write(${JSON.stringify(output)});`),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ['non-object hookSpecificOutput', '{"hookSpecificOutput":[]}'],
    ['misspelled permissionDecision', '{"hookSpecificOutput":{"permissionDecision":"denny"}}'],
    ['non-string permissionDecision', '{"hookSpecificOutput":{"permissionDecision":{"deny":true}}}'],
    ['non-scalar message', '{"message":[]}'],
  ])('returns block for parseable protocol output with %s', async (_case, output) => {
    const result = await runHook(
      hostProcess,
      nodeCommand(`process.stdout.write(${JSON.stringify(output)});`),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ['an unrelated parsed object', '{"unexpected":"value"}'],
    ['a quoted message prefix', "{'messageCount': 1}"],
    ['an unquoted message prefix', '{messageboard: "status"}'],
    ['a hookSpecificOutput prefix', "{'hookSpecificOutputDebug': true}"],
  ])('returns allow for non-protocol output with %s', async (_case, output) => {
    const result = await runHook(
      hostProcess,
      nodeCommand(`process.stdout.write(${JSON.stringify(output)});`),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('parses permissionDecision=allow into a structured allow result', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }));',
      ),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.structuredOutput).toBe(true);
  });

  it('parses stdout JSON permissionDecision=deny into a block result with the supplied reason', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "use rg" } }));',
      ),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toBe('use rg');
  });

  it('writes the input payload to the hook process stdin as JSON', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand([
        'let input = "";',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  const parsed = JSON.parse(input);',
        '  process.stdout.write(parsed.tool_name);',
        '});',
      ].join('\n')),
      { tool_name: 'Write' },
      { timeout: 5 },
    );

    expect(result.stdout?.trim()).toBe('Write');
  });
});

describe('buildHookSpawnOptions (Windows console-window regression)', () => {
  it('sets windowsHide:true so hooks do not flash a console on Windows', () => {
    expect(buildHookSpawnOptions({}).windowsHide).toBe(true);
  });

  it('runs through the shell with stdio piped', () => {
    const options = buildHookSpawnOptions({});
    expect(options.shell).toBe(true);
    expect(options.stdio).toBe('pipe');
  });

  it('merges hook env onto process.env and forwards cwd', () => {
    const options = buildHookSpawnOptions({ cwd: '/repo', env: { FOO: 'bar' } });
    expect(options.cwd).toBe('/repo');
    expect(options.env).toMatchObject({ FOO: 'bar' });
  });
});
