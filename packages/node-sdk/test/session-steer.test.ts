import type { ProtocolAdapterConfig } from '@moonshot-ai/agent-core-v2/kosong/protocol/protocol';
import { ProtocolAdapterRegistry } from '@moonshot-ai/agent-core-v2/kosong/provider/protocolAdapterRegistry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, type KimiError } from '#/index';

import { makeTempDir, removeTempDirs, waitForAgentWireEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const fakeProviderState = vi.hoisted(() => ({
  responseText: 'steer response',
}));

beforeEach(() => {
  vi.spyOn(ProtocolAdapterRegistry.prototype, 'createChatProvider').mockImplementation(
    (config: ProtocolAdapterConfig) =>
      ({
        name: config.providerType ?? 'fake',
        modelName: config.modelName,
        thinkingEffort: null,
        async generate() {
          return {
            id: 'fake-response',
            usage: {
              inputOther: 0,
              output: 1,
              inputCacheRead: 0,
              inputCacheCreation: 0,
            },
            finishReason: 'completed',
            rawFinishReason: 'stop',
            traceId: null,
            async *[Symbol.asyncIterator]() {
              yield { type: 'text', text: fakeProviderState.responseText };
            },
          };
        },
      }) as ReturnType<ProtocolAdapterRegistry['createChatProvider']>,
  );
});

const tempDirs: string[] = [];

beforeEach(() => {
  fakeProviderState.responseText = 'steer response';
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempDirs(tempDirs);
});

describe('Session.steer', () => {
  // `turn.steer` is recorded only when there is a running turn to steer into.
  // An idle steer degrades to launching the input as a fresh turn, so the wire
  // record it leaves is a `turn.prompt` — the assertion still pins that the
  // steered input reached the session runtime intact.
  it('sends an idle steer to the core session runtime as a fresh turn', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_steer_wire', workDir });

      await session.steer('also do this');

      await expect(
        waitForAgentWireEvent(homeDir, session.id, 'turn.prompt', (event) =>
          Array.isArray(event['input']),
        ),
      ).resolves.toMatchObject({
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'also do this' }],
      });
    } finally {
      await harness.close();
    }
  });

  it('rejects empty steer input', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_steer_empty', workDir });

      await expect(session.steer('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.prompt_input_empty',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_steer_closed', workDir });
      await session.close();

      await expect(session.steer('hello')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});
