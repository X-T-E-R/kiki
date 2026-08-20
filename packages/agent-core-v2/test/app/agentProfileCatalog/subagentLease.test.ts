import { describe, expect, it } from 'vitest';

import {
  parseSpawnConstraints,
  parseSubagentList,
  SubagentLeaseParseError,
} from '#/app/agentProfileCatalog/subagentLease';

const PATH = '/tmp/agents/grok-play.md';

describe('parseSubagentList', () => {
  it('treats a comma-separated string as names without leases', () => {
    expect(parseSubagentList('explore, worker-lite', PATH)).toEqual({
      subagents: ['explore', 'worker-lite'],
    });
  });

  it('treats a wildcard as an unrestricted allowlist', () => {
    expect(parseSubagentList(['explore', '*'], PATH)).toEqual({
      subagents: undefined,
    });
  });

  it('stores a * overlay on a named lease as unlimited replacement', () => {
    const parsed = parseSubagentList(
      [{ name: 'worker-lite', subagents: ['*'] }],
      PATH,
    );
    expect(parsed.subagentLeases?.['worker-lite']?.subagents).toBeNull();
  });

  it('stores tools: * as a full-open replacement rather than inherit', () => {
    const parsed = parseSubagentList([{ name: 'worker-lite', tools: ['*'] }], PATH);
    expect(parsed.subagentLeases?.['worker-lite']?.tools).toBeNull();
  });

  it('keeps an empty overlay as a leaf allowlist', () => {
    const parsed = parseSubagentList([{ name: 'worker-lite', subagents: [] }], PATH);
    expect(parsed.subagentLeases?.['worker-lite']?.subagents).toEqual([]);
  });

  it('rejects a mapping without name', () => {
    expect(() => parseSubagentList([{ model_alias: 'grok-4.6' }], PATH)).toThrow(
      SubagentLeaseParseError,
    );
  });
});

describe('parseSpawnConstraints', () => {
  it('parses the closed field set', () => {
    expect(
      parseSpawnConstraints(
        {
          allowed_models: ['grok-4.6'],
          deny_models: ['gpt-5.6-sol'],
          allowed_efforts: ['high'],
          disallowed_tools: ['Bash'],
        },
        PATH,
      ),
    ).toEqual({
      allowedModels: ['grok-4.6'],
      denyModels: ['gpt-5.6-sol'],
      allowedEfforts: ['high'],
      disallowedTools: ['Bash'],
    });
  });

  it('rejects an unknown key', () => {
    expect(() => parseSpawnConstraints({ model_alias: 'grok-4.6' }, PATH)).toThrow(
      /unknown key "model_alias"/,
    );
  });

  it('coerces empty lists to omitted fields', () => {
    expect(parseSpawnConstraints({ allowed_models: [] }, PATH)).toBeUndefined();
  });
});
