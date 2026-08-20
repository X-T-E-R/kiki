import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_INDEPENDENT_DELEGATION_NOTICE,
  DelegationFileError,
  injectDelegationContext,
  resolveDelegationPosition,
  resolveDelegationSnippet,
} from '#/agent/profile/delegationContext';
import { TASK_AGENT_ROLE_PREFIX } from '#/app/agentProfileCatalog/profile-shared';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

describe('resolveDelegationPosition', () => {
  it('classifies main, independent, and sub from agent id and delegator', () => {
    expect(resolveDelegationPosition('main', undefined)).toBe('main');
    expect(resolveDelegationPosition('main', { kind: 'external', delegationId: 'd1' })).toBe('main');
    expect(resolveDelegationPosition('agent-1', { kind: 'external', delegationId: 'd1' })).toBe(
      'independent',
    );
    expect(resolveDelegationPosition('agent-1', { kind: 'agent', agentId: 'main' })).toBe('sub');
    expect(resolveDelegationPosition('agent-1', undefined)).toBe('sub');
  });
});

describe('injectDelegationContext', () => {
  it('fills ${delegation_context} when the template already has the token', () => {
    expect(injectDelegationContext('HEAD\n${delegation_context}\nTAIL', 'NOTICE')).toBe(
      'HEAD\nNOTICE\nTAIL',
    );
  });

  it('prepends when the template does not have the token', () => {
    expect(injectDelegationContext('BODY', 'NOTICE')).toBe('NOTICE\n\nBODY');
  });

  it('strips the token when there is no snippet', () => {
    expect(injectDelegationContext('HEAD\n${delegation_context}\n\nTAIL', undefined)).toBe(
      'HEAD\n\nTAIL',
    );
  });
});

describe('resolveDelegationSnippet', () => {
  const pathClass = process.platform === 'win32' ? 'win32' : 'posix';
  const fs = new HostFileSystem();
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-delegation-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns no snippet for main, off, or a disabled slot', async () => {
    await expect(
      resolveDelegationSnippet({
        position: 'main',
        fs,
        homeDir,
        pathClass,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveDelegationSnippet({
        position: 'sub',
        notice: 'off',
        fs,
        homeDir,
        pathClass,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveDelegationSnippet({
        position: 'sub',
        config: { sub: false },
        fs,
        homeDir,
        pathClass,
      }),
    ).resolves.toBeUndefined();
  });

  it('uses the built-in TASK prefix and independent notice when config omits a slot', async () => {
    await expect(
      resolveDelegationSnippet({ position: 'sub', fs, homeDir, pathClass }),
    ).resolves.toBe(TASK_AGENT_ROLE_PREFIX);
    await expect(
      resolveDelegationSnippet({ position: 'independent', fs, homeDir, pathClass }),
    ).resolves.toBe(DEFAULT_INDEPENDENT_DELEGATION_NOTICE);
  });

  it('loads a declared home-relative file and fails closed when it is missing', async () => {
    await mkdir(join(homeDir, 'delegation'));
    await writeFile(join(homeDir, 'delegation/sub.md'), 'CUSTOM SUB\n');
    await expect(
      resolveDelegationSnippet({
        position: 'sub',
        config: { sub: 'delegation/sub.md' },
        fs,
        homeDir,
        pathClass,
      }),
    ).resolves.toBe('CUSTOM SUB');
    await expect(
      resolveDelegationSnippet({
        position: 'independent',
        config: { independent: 'delegation/missing.md' },
        fs,
        homeDir,
        pathClass,
      }),
    ).rejects.toMatchObject({ reason: 'missing', slot: 'independent' });
    await expect(
      resolveDelegationSnippet({
        position: 'sub',
        config: { sub: '/tmp/outside.md' },
        fs,
        homeDir,
        pathClass,
      }),
    ).rejects.toBeInstanceOf(DelegationFileError);
    await writeFile(join(homeDir, 'delegation/empty.md'), '   \n', 'utf-8');
    await expect(
      resolveDelegationSnippet({
        position: 'sub',
        config: { sub: 'delegation/empty.md' },
        fs,
        homeDir,
        pathClass,
      }),
    ).rejects.toMatchObject({ reason: 'empty', slot: 'sub' });
  });
});
