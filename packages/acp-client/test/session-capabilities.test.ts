import { PassThrough, Readable, Writable } from 'node:stream';

import { ndJsonStream } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { AcpProcessClient } from '../src/client';
import type { HostProcessLike } from '../src/types';

import {
  createInProcessScriptedAgent,
  type InProcessAgentScript,
} from './fixtures/in-process-scripted-agent';

function scriptedChild(): {
  child: HostProcessLike;
  toAgent: PassThrough;
  fromAgent: PassThrough;
} {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const wait = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const child: HostProcessLike = {
    pid: 42,
    get exitCode() {
      return exitCode;
    },
    stdin: toAgent,
    stdout: fromAgent,
    stderr,
    wait: () => wait,
    kill: async () => {
      if (exitCode === null) {
        exitCode = 0;
        resolveExit(0);
      }
    },
    dispose: () => {},
  };
  return { child, toAgent, fromAgent };
}

async function openWithScriptedAgent(
  script: InProcessAgentScript,
  options: {
    additionalDirectories?: readonly string[];
    sessionRef?: unknown;
    systemPromptOverride?: string;
  },
) {
  const { child, toAgent, fromAgent } = scriptedChild();
  const { app, history } = createInProcessScriptedAgent(script);
  app.connect(ndJsonStream(Writable.toWeb(fromAgent), Readable.toWeb(toAgent)));
  const client = new AcpProcessClient(
    { spawn: async () => child },
    { id: 'fixture', command: 'fixture', startupTimeoutMs: 5_000 },
    { platform: 'linux' },
  );
  try {
    const opened = await client.openSession({
      cwd: 'C:/workspace',
      additionalDirectories: options.additionalDirectories,
      sessionRef: options.sessionRef as never,
      systemPromptOverride: options.systemPromptOverride,
    });
    return { client, history, opened };
  } catch (error) {
    await client.shutdown().catch(() => undefined);
    throw error;
  }
}

describe('AcpProcessClient session capability negotiation', () => {
  it('declares the boolean session config option capability it uses', async () => {
    const { client, history } = await openWithScriptedAgent({}, {});
    try {
      const initialize = history.initializeParams[0] as {
        clientCapabilities: { session?: { configOptions?: { boolean?: unknown } } };
      };
      expect(initialize.clientCapabilities.session?.configOptions?.boolean).toEqual({});
    } finally {
      await client.shutdown();
    }
  });

  it('omits additional directories when the agent does not declare support for them', async () => {
    const { client, history } = await openWithScriptedAgent(
      { capabilities: {} },
      { additionalDirectories: ['C:/shared'] },
    );
    try {
      expect(history.sessionNewParams[0]).not.toHaveProperty('additionalDirectories');
    } finally {
      await client.shutdown();
    }
  });

  it('sends additional directories when the agent declares support for them', async () => {
    const { client, history } = await openWithScriptedAgent(
      { capabilities: { sessionCapabilities: { additionalDirectories: {} } } },
      { additionalDirectories: ['C:/shared'] },
    );
    try {
      expect(history.sessionNewParams[0]).toMatchObject({
        additionalDirectories: ['C:/shared'],
      });
    } finally {
      await client.shutdown();
    }
  });

  it('treats resume:null as unsupported and falls back through the open chain', async () => {
    const { client, history, opened } = await openWithScriptedAgent(
      { capabilities: { loadSession: true, sessionCapabilities: { resume: null } } },
      {
        sessionRef: {
          executorId: 'fixture',
          version: 1,
          ref: { sessionId: 'session-in-process' },
        },
      },
    );
    try {
      expect(opened.mode).toBe('load');
      expect(history.methods).not.toContain('session/resume');
      expect(history.methods).toContain('session/load');
      expect(history.sessionNewParams).toHaveLength(0);
    } finally {
      await client.shutdown();
    }
  });

  it('attempts session/resume when the agent declares resume support', async () => {
    const { client, history, opened } = await openWithScriptedAgent(
      { capabilities: { loadSession: true, sessionCapabilities: { resume: {} } } },
      {
        sessionRef: {
          executorId: 'fixture',
          version: 1,
          ref: { sessionId: 'session-in-process' },
        },
      },
    );
    try {
      expect(opened.mode).toBe('resume');
      expect(history.methods).toContain('session/resume');
    } finally {
      await client.shutdown();
    }
  });

  it('attaches a system prompt override to session/new through _meta', async () => {
    const { client, history, opened } = await openWithScriptedAgent(
      {},
      { systemPromptOverride: 'Frozen profile text' },
    );
    try {
      expect(opened.mode).toBe('new');
      expect(history.sessionNewParams[0]).toMatchObject({
        _meta: { systemPromptOverride: 'Frozen profile text' },
      });
    } finally {
      await client.shutdown();
    }
  });

  it('omits _meta from session/new when no override is requested', async () => {
    const { client, history } = await openWithScriptedAgent({}, {});
    try {
      expect(history.sessionNewParams[0]).not.toHaveProperty('_meta');
    } finally {
      await client.shutdown();
    }
  });

  it.each([
    [{}, 'resume'],
    [{ resume: 'method_not_found' as const }, 'load'],
    [{ resume: 'unknown_session' as const, load: 'unknown_session' as const }, 'new'],
  ] as const)('attaches the override only when the fallback open mode is %s', async (script, expectedMode) => {
    const { client, history, opened } = await openWithScriptedAgent(
      { capabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, ...script },
      {
        sessionRef: {
          executorId: 'fixture',
          version: 1,
          ref: { sessionId: 'session-in-process' },
        },
        systemPromptOverride: 'Frozen profile text',
      },
    );
    try {
      expect(opened.mode).toBe(expectedMode);
      expect(history.sessionResumeParams[0]).not.toHaveProperty('_meta');
      if (expectedMode !== 'resume') expect(history.sessionLoadParams[0]).not.toHaveProperty('_meta');
      if (expectedMode === 'new') {
        expect(history.sessionNewParams[0]).toMatchObject({
          _meta: { systemPromptOverride: 'Frozen profile text' },
        });
      } else {
        expect(history.sessionNewParams).toHaveLength(0);
      }
    } finally {
      await client.shutdown();
    }
  });
});
