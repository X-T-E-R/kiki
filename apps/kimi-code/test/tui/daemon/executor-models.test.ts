import { describe, expect, it } from 'vitest';
import type { ExecutorCatalogItem, ExecutorModelCatalogResponse } from '@kiki/protocol';

import {
  antigravityInstanceIdOf,
  buildEffortArgumentCompletions,
  buildLoginArgumentCompletions,
  buildModelArgumentCompletions,
  checkAntigravityPendingTargetMismatch,
  executorAdvertisesSlashCommand,
  executorThinkingLevelsForModel,
  formatExternalSlashCommandPrompt,
  isAntigravityExecutorId,
  parseAntigravityLoginArgs,
  pickExecutorThinkingForModel,
  resolveExecutorModels,
} from '../../../src/tui/daemon/executor-models.js';

const CATALOG: ExecutorCatalogItem[] = [
  {
    id: 'antigravity-acp',
    label: 'Antigravity',
    description: 'Google Antigravity CLI',
    family: 'acp',
    available: true,
    enabled: true,
    capabilities: {
      negotiated: {
        models: ['gemini-3.1-pro', 'claude-sonnet-4-6'],
        thinking_levels: ['low', 'medium', 'high'],
        model_thinking_levels: {
          'gemini-3.1-pro': ['low', 'high'],
          'gemini-3-flash': [],
        },
      },
    },
  } as unknown as ExecutorCatalogItem,
  {
    id: 'instance-agy-work',
    label: 'Antigravity · Work',
    description: 'Work Antigravity instance',
    family: 'acp',
    available: true,
    enabled: true,
    instance: {
      source_executor: 'antigravity-acp',
    },
  } as unknown as ExecutorCatalogItem,
];

describe('TUI daemon external executor model/effort/login helpers', () => {
  it('identifies Antigravity executors and derives instance ids', () => {
    expect(isAntigravityExecutorId('antigravity-acp', CATALOG)).toBe(true);
    expect(isAntigravityExecutorId('instance-agy-work', CATALOG)).toBe(true);
    expect(isAntigravityExecutorId('codex-app', CATALOG)).toBe(false);
    expect(antigravityInstanceIdOf('antigravity-acp', CATALOG)).toBeUndefined();
    expect(antigravityInstanceIdOf('instance-agy-work', CATALOG)).toBe('instance-agy-work');
  });

  it('resolves external models and per-model thinking levels cleanly', () => {
    const modelCatalog = {
      effective: {
        models: { state: 'ready', values: ['gemini-3.1-pro', 'gemini-3-flash'] },
        thinking_levels: { state: 'ready', values: ['low', 'medium', 'high'] },
      },
    } as unknown as ExecutorModelCatalogResponse;

    const resolved = resolveExecutorModels(
      'antigravity-acp',
      undefined,
      CATALOG[0],
      modelCatalog,
    );

    expect(resolved.models).toEqual(['gemini-3.1-pro', 'claude-sonnet-4-6', 'gemini-3-flash']);

    const proLevels = executorThinkingLevelsForModel(resolved, 'gemini-3.1-pro');
    expect(proLevels).toEqual(['low', 'high']);
    expect(pickExecutorThinkingForModel('medium', 'low', proLevels)).toBe('low');
    expect(pickExecutorThinkingForModel('high', 'low', proLevels)).toBe('high');

    const flashLevels = executorThinkingLevelsForModel(resolved, 'gemini-3-flash');
    expect(flashLevels).toEqual([]);
    expect(pickExecutorThinkingForModel('high', 'low', flashLevels)).toBeUndefined();
  });

  it('builds /model, /effort, and /login autocomplete completions', () => {
    const resolved = resolveExecutorModels('antigravity-acp', undefined, CATALOG[0], undefined);
    const modelItems = buildModelArgumentCompletions('claude', resolved, []);
    expect(modelItems.map((i) => i.value)).toEqual(['claude-sonnet-4-6']);

    const effortItems = buildEffortArgumentCompletions('h', ['low', 'high']);
    expect(effortItems.map((i) => i.value)).toEqual(['high']);

    const loginItems = buildLoginArgumentCompletions('work', CATALOG, false);
    expect(loginItems.map((i) => i.value)).toEqual(['instance-agy-work']);

    const pendingItems = buildLoginArgumentCompletions('can', CATALOG, true);
    expect(pendingItems.map((i) => i.value)).toEqual(['cancel']);
  });

  it('parses Antigravity /login arguments for start, code paste, cancel, and multi-account targets', () => {
    expect(parseAntigravityLoginArgs('', 'antigravity-acp', CATALOG, undefined)).toEqual({
      kind: 'start',
      instanceId: undefined,
    });
    expect(parseAntigravityLoginArgs('antigravity-acp 4/0A-auth-code', undefined, CATALOG, undefined)).toEqual({
      kind: 'complete',
      codeOrUrl: '4/0A-auth-code',
      instanceId: undefined,
      explicitTargetId: 'antigravity-acp',
    });
    expect(
      parseAntigravityLoginArgs('4/0A-pasted-directly', undefined, CATALOG, { handle: 'h-1', instanceId: 'instance-agy-work' }),
    ).toEqual({
      kind: 'complete',
      codeOrUrl: '4/0A-pasted-directly',
      instanceId: 'instance-agy-work',
    });
    expect(
      parseAntigravityLoginArgs('cancel', undefined, CATALOG, { handle: 'h-1' }),
    ).toEqual({ kind: 'cancel' });
    expect(parseAntigravityLoginArgs('instance-agy-work', 'instance-agy-work', CATALOG, undefined)).toEqual({
      kind: 'start',
      instanceId: 'instance-agy-work',
    });
    expect(parseAntigravityLoginArgs('kimi-code', undefined, CATALOG, undefined)).toBeUndefined();
  });

  it('rejects completing a pending Antigravity login when an explicit target mismatches the pending target', () => {
    const pendingWork = { handle: 'h-work', instanceId: 'instance-agy-work' };
    const mismatchParsed = parseAntigravityLoginArgs('antigravity-acp 4/0A-wrong-target', undefined, CATALOG, pendingWork);
    expect(mismatchParsed?.kind).toBe('complete');
    if (mismatchParsed?.kind !== 'complete') throw new Error('expected complete');
    expect(checkAntigravityPendingTargetMismatch(mismatchParsed, pendingWork)).toContain('instance-agy-work');
    expect(checkAntigravityPendingTargetMismatch(mismatchParsed, pendingWork)).toContain('antigravity-acp');

    const matchParsed = parseAntigravityLoginArgs('instance-agy-work 4/0A-right-target', undefined, CATALOG, pendingWork);
    if (matchParsed?.kind !== 'complete') throw new Error('expected complete');
    expect(checkAntigravityPendingTargetMismatch(matchParsed, pendingWork)).toBeUndefined();

    const bareParsed = parseAntigravityLoginArgs('4/0A-bare-code', undefined, CATALOG, pendingWork);
    if (bareParsed?.kind !== 'complete') throw new Error('expected complete');
    expect(checkAntigravityPendingTargetMismatch(bareParsed, pendingWork)).toBeUndefined();
  });

  it('detects negotiated external /compact slash command and formats the prompt', () => {
    expect(executorAdvertisesSlashCommand('compact', { slash_commands: ['compact', 'init'] }, undefined)).toBe(true);
    expect(executorAdvertisesSlashCommand('compact', { slash_commands: ['/COMPACT'] }, undefined)).toBe(true);
    expect(executorAdvertisesSlashCommand('compact', undefined, {
      ...CATALOG[0]!,
      capabilities: {
        ...CATALOG[0]!.capabilities!,
        negotiated: { ...CATALOG[0]!.capabilities!.negotiated, slash_commands: ['compact'] },
      },
    })).toBe(true);
    expect(executorAdvertisesSlashCommand('compact', { slash_commands: ['init'] }, undefined)).toBe(false);
    expect(executorAdvertisesSlashCommand('compact', undefined, CATALOG[0])).toBe(false);
    expect(formatExternalSlashCommandPrompt('compact', '')).toBe('/compact');
    expect(formatExternalSlashCommandPrompt('/compact', '  preserve auth context  ')).toBe('/compact preserve auth context');
  });
});
