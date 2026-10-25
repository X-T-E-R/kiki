import { describe, expect, it } from 'vitest';
import type { Block } from '@kiki/session-core/session';

import {
  agentOutputSignature,
  formatBusyActivityMessage,
  formatElapsedDuration,
  getCurrentTurnBlocks,
  isQueuedUserBlock,
  latestAgentTimestamp,
  TurnActivityTracker,
} from '#/tui/daemon/activity-status-helper';

describe('activity-status-helper', () => {
  describe('formatElapsedDuration', () => {
    it('formats seconds, minutes, and hours matching footer format', () => {
      expect(formatElapsedDuration(0)).toBe('0s');
      expect(formatElapsedDuration(5_000)).toBe('5s');
      expect(formatElapsedDuration(59_000)).toBe('59s');
      expect(formatElapsedDuration(60_000)).toBe('1m');
      expect(formatElapsedDuration(119_000)).toBe('1m');
      expect(formatElapsedDuration(120_000)).toBe('2m');
      expect(formatElapsedDuration(3_599_000)).toBe('59m');
      expect(formatElapsedDuration(3_600_000)).toBe('1h0m');
      expect(formatElapsedDuration(3_660_000)).toBe('1h1m');
      expect(formatElapsedDuration(7_320_000)).toBe('2h2m');
    });
  });

  describe('isQueuedUserBlock', () => {
    it('identifies queued user blocks correctly', () => {
      const normalUser: Block = { kind: 'user', id: 'u1', text: 'hi', createdAt: '2026-10-18T00:00:00.000Z' };
      const queuedPromptStatus: Block = { kind: 'user', id: 'u2', text: 'queued', createdAt: '2026-10-18T00:00:00.000Z', promptStatus: 'queued' };
      const steerWaiting: Block = { kind: 'user', id: 'u3', text: 'steer', createdAt: '2026-10-18T00:00:00.000Z', steerStatus: 'waiting' };
      const steerSending: Block = { kind: 'user', id: 'u4', text: 'steer', createdAt: '2026-10-18T00:00:00.000Z', steerStatus: 'sending' };
      const inQueuedList: Block = { kind: 'user', id: 'u5', promptId: 'p-5', text: 'queued', createdAt: '2026-10-18T00:00:00.000Z' };

      expect(isQueuedUserBlock(normalUser)).toBe(false);
      expect(isQueuedUserBlock(queuedPromptStatus)).toBe(true);
      expect(isQueuedUserBlock(steerWaiting)).toBe(true);
      expect(isQueuedUserBlock(steerSending)).toBe(true);
      expect(isQueuedUserBlock(inQueuedList, ['p-5'])).toBe(true);
      expect(isQueuedUserBlock(inQueuedList, ['other'])).toBe(false);
    });
  });

  describe('getCurrentTurnBlocks', () => {
    it('isolates blocks after the last non-queued user block', () => {
      const u1: Block = { kind: 'user', id: 'u1', text: 'turn 1', createdAt: '2026-10-18T00:00:00.000Z' };
      const a1: Block = { kind: 'assistant', id: 'a1', text: 'turn 1 response', streaming: false, createdAt: '2026-10-18T00:00:05.000Z' };
      const u2: Block = { kind: 'user', id: 'u2', text: 'turn 2', createdAt: '2026-10-18T01:00:00.000Z' };
      const th2: Block = { kind: 'thinking', id: 'th2', text: 'thinking...', streaming: true, createdAt: '2026-10-18T01:00:01.000Z' };
      const queuedU3: Block = { kind: 'user', id: 'u3', text: 'turn 3 queued', createdAt: '2026-10-18T01:00:02.000Z', promptStatus: 'queued' };

      const blocks = [u1, a1, u2, th2, queuedU3];
      const current = getCurrentTurnBlocks(blocks);

      expect(current).toEqual([th2]);
    });

    it('returns empty array when Turn 2 has no agent output yet despite Turn 1 having output', () => {
      const u1: Block = { kind: 'user', id: 'u1', text: 'turn 1', createdAt: '2026-10-18T00:00:00.000Z' };
      const a1: Block = { kind: 'assistant', id: 'a1', text: 'turn 1 response', streaming: false, createdAt: '2026-10-18T00:00:05.000Z' };
      const u2: Block = { kind: 'user', id: 'u2', text: 'turn 2', createdAt: '2026-10-18T01:00:00.000Z' };

      const blocks = [u1, a1, u2];
      const current = getCurrentTurnBlocks(blocks);

      expect(current).toEqual([]);
    });

    it('falls back to turnStartedAt when no user block exists', () => {
      const turnStartedAt = Date.parse('2026-10-18T01:00:00.000Z');
      const oldA: Block = { kind: 'assistant', id: 'a0', text: 'old', streaming: false, createdAt: '2026-10-18T00:50:00.000Z' };
      const newA: Block = { kind: 'assistant', id: 'a1', text: 'new', streaming: true, createdAt: '2026-10-18T01:00:02.000Z' };

      expect(getCurrentTurnBlocks([oldA, newA], undefined, turnStartedAt)).toEqual([newA]);
    });

    it('returns empty array on cold-open without user block and without turnStartedAt', () => {
      const oldA: Block = { kind: 'assistant', id: 'a0', text: 'old', streaming: false, createdAt: '2026-10-18T00:50:00.000Z' };
      expect(getCurrentTurnBlocks([oldA], undefined, undefined)).toEqual([]);
    });
  });

  describe('TurnActivityTracker', () => {
    const baseNow = 1_700_000_000_000;

    it('handles old agent history + new busy with no response (Counter-example 1)', () => {
      const tracker = new TurnActivityTracker();
      const u1: Block = { kind: 'user', id: 'u1', text: 'old', createdAt: new Date(baseNow - 3_600_000).toISOString() };
      const a1: Block = { kind: 'assistant', id: 'a1', text: 'old response', streaming: false, createdAt: new Date(baseNow - 3_500_000).toISOString() };
      const u2: Block = { kind: 'user', id: 'u2', text: 'new turn', createdAt: new Date(baseNow).toISOString() };

      const turnStartedAt = baseNow;
      const res = tracker.update(true, [u1, a1, u2], turnStartedAt, undefined, baseNow);

      expect(res.hasResponded).toBe(false);
      expect(res.lastResponseAt).toBeUndefined();

      // Formatted message in Window 1 at 4s elapsed
      const msg = formatBusyActivityMessage({
        runningTasks: 0,
        turnStartedAt,
        hasResponded: res.hasResponded,
        lastResponseAt: res.lastResponseAt,
        now: baseNow + 4_000,
      });
      expect(msg).toBe('Working · waited 4s');
    });

    it('handles cold-open with unknown turnStartedAt (Counter-example 2)', () => {
      const tracker = new TurnActivityTracker();
      const u1: Block = { kind: 'user', id: 'u1', text: 'prompt before restart', createdAt: new Date(baseNow - 3_600_000).toISOString() };
      const a1: Block = { kind: 'assistant', id: 'a1', text: 'response before restart', streaming: false, createdAt: new Date(baseNow - 3_500_000).toISOString() };

      // Cold open: busy is true, but options.cold === true sets turnStartedAt to undefined
      const res = tracker.update(true, [u1, a1], undefined, undefined, baseNow);

      // On cold-open without trusted turnStartedAt, we must NOT show ancient lastResponseAt
      expect(res.lastResponseAt).toBeUndefined();

      const msg = formatBusyActivityMessage({
        runningTasks: 0,
        turnStartedAt: undefined,
        hasResponded: res.hasResponded,
        lastResponseAt: res.lastResponseAt,
        now: baseNow + 10_000,
      });
      expect(msg).toBe('Working…');
      expect(msg).not.toContain('ago');
      expect(msg).not.toContain('waited');
    });

    it('handles subagent without timestamp without continuing waited or faking ago (Counter-example 3)', () => {
      const tracker = new TurnActivityTracker();
      const u1: Block = { kind: 'user', id: 'u1', text: 'start subagent', createdAt: new Date(baseNow).toISOString() };
      const sub1: Block = {
        kind: 'subagent',
        id: 'sub-1',
        subagentId: 'sa-1',
        parentAgentId: 'main',
        parentToolCallId: undefined,
        name: 'worker',
        description: 'run task',
        model: undefined,
        thinkingEffort: undefined,
        status: 'running',
        summary: undefined,
        error: undefined,
        endedAt: undefined,
        toolCallCount: 0,
        transcript: [],
      };

      const turnStartedAt = baseNow;
      const res = tracker.update(true, [u1, sub1], turnStartedAt, undefined, baseNow);

      expect(res.hasResponded).toBe(true);
      expect(res.lastResponseAt).toBeUndefined();

      // Formatted message: agent responded so NO waited, and no timestamp so NO fake ago
      const msg = formatBusyActivityMessage({
        runningTasks: 0,
        turnStartedAt,
        hasResponded: res.hasResponded,
        lastResponseAt: res.lastResponseAt,
        now: baseNow + 10_000,
      });
      expect(msg).toBe('Working…');
      expect(msg).not.toContain('waited');
      expect(msg).not.toContain('last response');
    });

    it('tracks streaming text growth on the same assistant block id (Counter-example 4)', () => {
      const tracker = new TurnActivityTracker();
      const u1: Block = { kind: 'user', id: 'u1', text: 'prompt', createdAt: new Date(baseNow).toISOString() };
      const a1Start: Block = {
        kind: 'assistant',
        id: 'a1',
        text: 'Hello',
        streaming: true,
        createdAt: new Date(baseNow + 1_000).toISOString(),
      };

      const turnStartedAt = baseNow;
      // Rising edge at baseNow + 1000
      let res = tracker.update(true, [u1, a1Start], turnStartedAt, undefined, baseNow + 1_000);
      expect(res.hasResponded).toBe(true);
      expect(res.lastResponseAt).toBe(baseNow + 1_000);

      // Advance time to baseNow + 10_000 with same block id streaming more text
      const a1Grown: Block = {
        kind: 'assistant',
        id: 'a1',
        text: 'Hello world, here is the rest of the stream',
        streaming: true,
        createdAt: new Date(baseNow + 1_000).toISOString(), // createdAt stays original!
      };

      res = tracker.update(true, [u1, a1Grown], turnStartedAt, undefined, baseNow + 10_000);
      expect(res.hasResponded).toBe(true);
      // lastResponseAt must be updated to the receive time (baseNow + 10_000), not stuck at baseNow + 1000!
      expect(res.lastResponseAt).toBe(baseNow + 10_000);

      // Tool progress update
      const tool1: Block = {
        kind: 'tool',
        id: 't1',
        toolCallId: 'tc1',
        name: 'Bash',
        argsText: 'ls',
        args: {},
        display: undefined,
        description: undefined,
        status: 'running',
        output: '',
        progressText: 'Compiling 10%',
        isError: false,
        startedAt: baseNow + 12_000,
        durationMs: undefined,
      };

      res = tracker.update(true, [u1, a1Grown, tool1], turnStartedAt, undefined, baseNow + 12_000);
      expect(res.lastResponseAt).toBe(baseNow + 12_000);

      const tool1Progress: Block = {
        ...tool1,
        progressText: 'Compiling 90%',
      };

      res = tracker.update(true, [u1, a1Grown, tool1Progress], turnStartedAt, undefined, baseNow + 18_000);
      expect(res.lastResponseAt).toBe(baseNow + 18_000);
    });

    it('ignores user prompt changes and queued prompts from resetting lastResponseAt (Counter-example 5)', () => {
      const tracker = new TurnActivityTracker();
      const u1: Block = { kind: 'user', id: 'u1', text: 'prompt', createdAt: new Date(baseNow).toISOString() };
      const a1: Block = {
        kind: 'assistant',
        id: 'a1',
        text: 'Finished answer',
        streaming: false,
        createdAt: new Date(baseNow + 2_000).toISOString(),
      };

      const turnStartedAt = baseNow;
      tracker.update(true, [u1, a1], turnStartedAt, undefined, baseNow + 2_000);

      // At baseNow + 15_000, user adds a queued prompt
      const u2Queued: Block = {
        kind: 'user',
        id: 'u2',
        promptId: 'p2',
        promptStatus: 'queued',
        text: 'queued prompt',
        createdAt: new Date(baseNow + 15_000).toISOString(),
      };

      const res = tracker.update(true, [u1, a1, u2Queued], turnStartedAt, ['p2'], baseNow + 15_000);
      // lastResponseAt must stay at baseNow + 2_000, NOT advance to baseNow + 15_000
      expect(res.lastResponseAt).toBe(baseNow + 2_000);
    });
  });

  describe('formatBusyActivityMessage', () => {
    const baseNow = 1_700_000_000_000;

    it('Window 1: returns pure Working… when elapsed < 3000ms', () => {
      expect(
        formatBusyActivityMessage({
          runningTasks: 0,
          turnStartedAt: baseNow - 2_500,
          hasResponded: false,
          lastResponseAt: undefined,
          now: baseNow,
        }),
      ).toBe('Working…');

      expect(
        formatBusyActivityMessage({
          runningTasks: 1,
          turnStartedAt: baseNow - 1_000,
          hasResponded: false,
          lastResponseAt: undefined,
          now: baseNow,
        }),
      ).toBe('Working · 1 tasks running');
    });

    it('Window 1: appends waited suffix when elapsed >= 3000ms', () => {
      expect(
        formatBusyActivityMessage({
          runningTasks: 0,
          turnStartedAt: baseNow - 3_000,
          hasResponded: false,
          lastResponseAt: undefined,
          now: baseNow,
        }),
      ).toBe('Working · waited 3s');

      expect(
        formatBusyActivityMessage({
          runningTasks: 2,
          turnStartedAt: baseNow - 18_000,
          hasResponded: false,
          lastResponseAt: undefined,
          now: baseNow,
        }),
      ).toBe('Working · 2 tasks running · waited 18s');
    });

    it('Window 2: hands off to last response ago when hasResponded is true', () => {
      expect(
        formatBusyActivityMessage({
          runningTasks: 0,
          turnStartedAt: baseNow - 30_000,
          hasResponded: true,
          lastResponseAt: baseNow - 5_000,
          now: baseNow,
        }),
      ).toBe('Working · last response 5s ago');

      expect(
        formatBusyActivityMessage({
          runningTasks: 2,
          turnStartedAt: baseNow - 30_000,
          hasResponded: true,
          lastResponseAt: baseNow - 12_000,
          now: baseNow,
        }),
      ).toBe('Working · 2 tasks running · last response 12s ago');
    });

    it('handles clock skew gracefully when now < turnStartedAt', () => {
      expect(
        formatBusyActivityMessage({
          runningTasks: 0,
          turnStartedAt: baseNow + 5_000,
          hasResponded: false,
          lastResponseAt: undefined,
          now: baseNow,
        }),
      ).toBe('Working…');
    });
  });
});
