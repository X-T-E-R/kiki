import { describe, expect, it } from 'vitest';
import { parseAgentReceipt } from './SubagentInvocationView';

describe('invocation receipt header', () => {
  it('stops at the first blank line, preserves colons, and accepts future advisory fields', () => {
    const receipt = parseAgentReceipt('task_id: task:one\r\nagent_id: child\r\nbinding_advisories: [{"code":"future_code","effectiveValue":"high","extra":true}]\r\n \r\nactual_profile: not-a-header');
    expect(receipt.headers['task_id']).toBe('task:one');
    expect(receipt.headers['actual_profile']).toBeUndefined();
    expect(receipt.advisories).toEqual([{ code: 'future_code', effectiveValue: 'high', extra: true }]);
  });

  it('distinguishes a known empty list from legacy first-only receipts', () => {
    expect(parseAgentReceipt('binding_advisories: []\nbinding_advisory_first: {"code":"old"}').advisories).toEqual([]);
    const legacy = parseAgentReceipt('binding_advisory_count: 3\nbinding_advisory_first: {"code":"old"}');
    expect(legacy.advisories).toBeUndefined();
    expect(legacy.first).toEqual({ code: 'old' });
    expect(legacy.headers['binding_advisory_count']).toBe('3');
  });

  it('rejects malformed structured advisory data but retains raw header values', () => {
    for (const value of ['oops', '[null]', '[1]', '{"code":"wrong-container"}']) {
      const receipt = parseAgentReceipt(`binding_advisories: ${value}\nbinding_advisory_first: null`);
      expect(receipt.advisories).toBeUndefined();
      expect(receipt.first).toBeUndefined();
      expect(receipt.headers['binding_advisories']).toBe(value);
    }
  });
});
