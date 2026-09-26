import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, describe, it } from 'vitest';

import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import {
  appService,
  createTestAgent,
  execEnvServices,
} from '../../harness/agent';

const enabled = new Set(
  (process.env['KIKI_EXTERNAL_HARNESS_SMOKE'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const outputRoot = process.env['KIKI_EXTERNAL_HARNESS_SMOKE_OUTPUT']
  ?? resolve(process.cwd(), '.tmp', 'external-harness-smoke');
const contexts: Array<ReturnType<typeof createTestAgent>> = [];

const cases = [
  {
    id: 'grok-acp',
    model: process.env['KIKI_GROK_ACP_SMOKE_MODEL'] ?? 'grok-4.6',
  },
  {
    id: 'kimi-acp',
    model: process.env['KIKI_ACP_SMOKE_MODEL'] ?? 'kimi-for-coding',
  },
  {
    id: 'codex-app-server',
    model: process.env['KIKI_CODEX_APP_SERVER_SMOKE_MODEL'] ?? 'YOUR_EXACT_CODEX_MODEL_ID',
  },
  {
    id: 'codex-acp',
    model: process.env['KIKI_CODEX_ACP_SMOKE_MODEL'] ?? 'YOUR_EXACT_CODEX_MODEL_ID',
  },
  {
    id: 'cursor-acp',
    model: process.env['KIKI_CURSOR_ACP_SMOKE_MODEL'] ?? 'YOUR_EXACT_CURSOR_MODEL_ID',
  },
  {
    id: 'claude-acp',
    model: process.env['KIKI_CLAUDE_ACP_SMOKE_MODEL'] ?? 'YOUR_EXACT_CLAUDE_MODEL_ID',
  },
  {
    id: 'gemini-acp',
    model: process.env['KIKI_GEMINI_ACP_SMOKE_MODEL'] ?? 'YOUR_EXACT_GEMINI_MODEL_ID',
  },
  {
    id: 'opencode-acp',
    model: process.env['KIKI_OPENCODE_ACP_SMOKE_MODEL'] ?? 'YOUR_EXACT_OPENCODE_MODEL_ID',
  },
] as const;

const prompt = 'Reply with exactly KIKI_EXTERNAL_SMOKE_OK. Do not call tools.';

function captureSessionNewOverride(
  runner: HostProcessService,
  capture: (override: unknown) => void,
): IHostProcessService {
  return {
    _serviceBrand: undefined,
    spawn: async (command, args, options) => {
      const child = await runner.spawn(command, args, options);
      const stdin = new PassThrough();
      let pending = '';
      stdin.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        let end = pending.indexOf('\n');
        while (end !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (line.trim().length > 0) {
            const message = JSON.parse(line) as {
              method?: string;
              params?: { _meta?: { systemPromptOverride?: unknown } };
            };
            if (message.method === 'session/new') {
              capture(message.params?._meta?.systemPromptOverride);
            }
          }
          end = pending.indexOf('\n');
        }
      });
      stdin.pipe(child.stdin);
      return {
        _serviceBrand: undefined,
        pid: child.pid,
        get exitCode() { return child.exitCode; },
        stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        wait: () => child.wait(),
        kill: (signal) => child.kill(signal),
        dispose: () => child.dispose(),
      };
    },
  };
}

describe('external harness real smoke', () => {
  afterAll(async () => {
    await Promise.all(contexts.map((context) => context.close()));
  });

  for (const smokeCase of cases) {
    const run = enabled.has(smokeCase.id) ? it : it.skip;
    run(smokeCase.id, { timeout: 300_000 }, async () => {
      let observedOverride: unknown;
      const runner = new HostProcessService();
      const processRunner = smokeCase.id === 'grok-acp'
        ? captureSessionNewOverride(runner, (override) => { observedOverride = override; })
        : runner;
      const context = createTestAgent(
        execEnvServices({ processRunner }),
        appService(IHostEnvironment, {
          _serviceBrand: undefined,
          osKind: 'Windows',
          osArch: process.arch,
          osVersion: 'smoke',
          shellName: 'bash',
          shellPath: 'bash',
          pathClass: 'win32',
          homeDir: process.env['USERPROFILE'] ?? process.cwd(),
          ready: Promise.resolve(),
        }),
        { cwd: process.cwd() },
      );
      contexts.push(context);
      const descriptor = (await context.get(IAgentExecutorRegistry).resolveExecutable(smokeCase.id)).descriptor;
      assert.doesNotMatch(descriptor.args.join(' '), /always-approve|\byolo\b|bypass/i);
      context.get(IAgentProfileService).applyBindingSnapshot({
        modelAlias: smokeCase.model,
        thinkingLevel: 'off',
        systemPrompt: 'Return only the requested fixed text and do not call tools.',
        executorId: smokeCase.id,
        executorProtocol: descriptor!.protocol,
        executorOptions: {},
        executorDescriptorRevision: descriptor!.revision,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('external harness smoke timed out')), 290_000);
      try {
        const handle = await context.get(IAgentExecutionService).run(
          { kind: 'prompt', prompt },
          { signal: controller.signal },
        );
        const completion = await handle.completion;
        assert.equal(completion.summary.trim(), 'KIKI_EXTERNAL_SMOKE_OK');
        const records = await context.persistedWireRecords();
        const execution = records.find((record) => record.type === 'executor.turn.metadata');
        assert.equal(execution?.['executorId'], smokeCase.id);
        assert.equal(execution?.['protocol'], descriptor.protocol);
        if (smokeCase.id === 'grok-acp') {
          assert.equal(observedOverride, 'Return only the requested fixed text and do not call tools.');
          assert.equal(execution?.['profileDelivery'], 'system_prompt_override');
          assert.equal((execution?.['losses'] as string[]).includes('profile_as_user_preamble'), false);
        }
        assert.equal(records.some((record) => record.type === 'turn.ended'), true);

        const outputDir = resolve(outputRoot, smokeCase.id);
        await mkdir(outputDir, { recursive: true });
        const transcriptPath = resolve(outputDir, 'wire.jsonl');
        const receiptPath = resolve(outputDir, 'receipt.json');
        await writeFile(
          transcriptPath,
          `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
          'utf8',
        );
        await writeFile(
          receiptPath,
          `${JSON.stringify({
            executorId: smokeCase.id,
            modelAlias: smokeCase.model,
            prompt,
            summary: completion.summary,
            transcriptPath,
            execution,
            systemPromptOverrideOnWire: smokeCase.id === 'grok-acp' ? true : undefined,
          }, null, 2)}\n`,
          'utf8',
        );
      } finally {
        clearTimeout(timer);
      }
    });
  }
});
