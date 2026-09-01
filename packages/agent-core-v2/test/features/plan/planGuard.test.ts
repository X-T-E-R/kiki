import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, TestInstantiationService } from '#/_base/di/test';
import { abortable } from '#/_base/utils/abort';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  ApprovalResponse,
  PermissionMode,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { EnterPlanModeReview } from '#/features/plan/enterPlanModeReview';
import { IAgentPlanService } from '#/features/plan/plan';
import { PlanFileWriteApprovePolicy } from '#/features/plan/planFileWriteApprovePolicy';
import { AgentPlanService } from '#/features/plan/planService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IConfigService } from '#/app/config/config';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ToolCall } from '#/kosong/contract/message';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionApprovalService } from '#/session/approval/approval';
import { SessionApprovalService } from '#/session/approval/approvalService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ToolAccesses } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { registerTestAgentWireServices } from '../../wire/stubs';
import { stubPermissionModeService } from '../../agent/permissionMode/stubs';
import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';

const signal = new AbortController().signal;
const SESSION_DIR = '/session';
const PLAN_ID = 'plan-1';
const PLAN_PATH = `${SESSION_DIR}/agents/test-agent/plans/${PLAN_ID}.md`;

const options = [
  { label: 'Approach A', description: 'Small change.' },
  { label: 'Approach B', description: 'Larger change.' },
] as const;

type AskResult = Extract<PermissionPolicyResult, { kind: 'ask' }>;

interface ApprovalRequestRecord {
  readonly ask: AskResult;
  readonly origin: string;
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id: `call_${name.toLowerCase()}`,
    name,
    arguments: JSON.stringify(args),
  };
}

function hookContext(
  toolName: string,
  input: {
    readonly args?: Record<string, unknown>;
    readonly accesses?: ToolAccesses;
    readonly display?: ToolInputDisplay;
  } = {},
): ResolvedToolExecutionHookContext {
  const args = input.args ?? {};
  const call = toolCall(toolName, args);
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args,
    execution: {
      accesses: input.accesses,
      display: input.display,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  };
}

function planEnterDisplay(): ToolInputDisplay {
  return { kind: 'plan_enter' };
}

function planReviewDisplay(
  input: {
    readonly plan?: string;
    readonly path?: string | undefined;
    readonly options?: readonly (typeof options)[number][] | undefined;
  } = {},
): ToolInputDisplay {
  const display: ToolInputDisplay = {
    kind: 'plan_review',
    plan: input.plan ?? '# Plan',
  };
  const path = 'path' in input ? input.path : PLAN_PATH;
  if (path !== undefined) {
    display.path = path;
  }
  if (input.options !== undefined) {
    display.options = input.options;
  }
  return display;
}

function mapResolution(
  resolution: PermissionPolicyResolution | undefined,
): BeforeExecuteDecision | undefined {
  if (resolution === undefined) return undefined;
  if (resolution.kind === 'approve') {
    return { executionMetadata: resolution.executionMetadata };
  }
  if (resolution.kind === 'result') {
    return { veto: resolution.result };
  }
  throw new Error('unexpected approval resolution');
}

describe('AgentPlanService plan-guard listener', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let permissionRan: boolean;
  let permissionStandInRegistered: boolean;
  let records: TelemetryRecord[];
  let requests: ApprovalRequestRecord[];
  let approvalResponse: ApprovalResponse;
  let requestToolApproval: Mock<IAgentToolApprovalService['requestToolApproval']>;
  let formatDenyMessage: Mock<(message: string) => string>;
  let mode: PermissionMode;
  let files: Map<string, string>;

  beforeEach(() => {
    disposables = new DisposableStore();
    records = [];
    requests = [];
    approvalResponse = { decision: 'approved' };
    requestToolApproval = vi.fn(async (_context, ask, origin) => {
      requests.push({ ask, origin });
      return mapResolution(ask.resolveApproval?.(approvalResponse));
    });
    formatDenyMessage = vi.fn((message: string) => message);
    mode = 'manual';
    files = new Map();
    permissionRan = false;
    permissionStandInRegistered = false;
    executorEvents = stubToolExecutorEvents();

    const toolApproval: IAgentToolApprovalService = {
      _serviceBrand: undefined,
      resolvePermissionResolution: async () => {
        throw new Error('resolvePermissionResolution is not used by the plan-guard listener');
      },
      requestToolApproval,
      formatDenyMessage: (message: string) => formatDenyMessage(message),
      formatApprovalRejectionMessage: (toolName, result) =>
        `Tool "${toolName}" was not run (${result.decision}).`,
    };

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        registerTestAgentWireServices(reg);
        reg.defineInstance(
          IHostFileSystem,
          createFakeHostFs({
            mkdir: vi.fn().mockResolvedValue(undefined),
            readText: vi.fn(async (path: string) => files.get(path) ?? ''),
            writeText: vi.fn(async (path: string, content: string) => {
              files.set(path, content);
            }),
          }),
        );
        reg.definePartialInstance(ISessionContext, {
          sessionId: 'session-1',
          sessionDir: SESSION_DIR,
        });
        reg.definePartialInstance(IAgentContextMemoryService, {});
        reg.definePartialInstance(IAgentContextInjectorService, {
          register: () => ({ dispose: () => {} }),
        });
        reg.definePartialInstance(IAgentTelemetryContextService, { set: () => {} });
        reg.defineInstance(IAgentToolExecutorService, executorEvents.executor);
        reg.defineInstance(IAgentToolApprovalService, toolApproval);
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.definePartialInstance(ISessionApprovalService, {
          decide: () => {},
        });
        reg.definePartialInstance(IConfigService, {
          get: (() => ({
            gate: 'gated',
            enterApprovalTimeoutMs: 5000,
          })) as IConfigService['get'],
        });
        reg.defineInstance(ITelemetryService, recordingTelemetry(records));
        reg.defineInstance(IAgentStateService, new AgentStateService());
        reg.define(IAgentPlanService, AgentPlanService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  function plan(): IAgentPlanService {
    return ix.get(IAgentPlanService);
  }

  async function enterPlan(): Promise<IAgentPlanService> {
    const svc = plan();
    await svc.enter(PLAN_ID);
    return svc;
  }

  async function run(
    ctx: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    if (!permissionStandInRegistered) {
      permissionStandInRegistered = true;
      disposables.add(
        executorEvents.executor.onBeforeExecuteTool(() => {
          permissionRan = true;
        }),
      );
    }
    return executorEvents.fireBeforeExecute(ctx);
  }

  describe('guard', () => {
    it.each(['Write', 'Edit'] as const)(
      'lets a %s that only targets the active plan file continue through adjudication',
      async (toolName) => {
        await enterPlan();
        const decision = await run(
          hookContext(toolName, {
            args: { path: PLAN_PATH },
            accesses: ToolAccesses.writeFile(PLAN_PATH),
          }),
        );

        expect(decision).toBeUndefined();
        expect(permissionRan).toBe(true);
      },
    );

    it('lets multiple writes through when every write access targets the active plan file', async () => {
      await enterPlan();
      const decision = await run(
        hookContext('Edit', {
          args: { path: PLAN_PATH },
          accesses: [
            { kind: 'file', operation: 'write', path: PLAN_PATH },
            { kind: 'file', operation: 'readwrite', path: PLAN_PATH },
          ],
        }),
      );

      expect(decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });

    it.each(['Write', 'Edit'] as const)(
      'blocks a %s to a non-plan file with a formatted deny reason',
      async (toolName) => {
        await enterPlan();
        const otherPath = '/workspace/src/main.ts';
        const decision = await run(
          hookContext(toolName, {
            args: { path: otherPath },
            accesses: ToolAccesses.writeFile(otherPath),
          }),
        );

        expect(decision?.veto?.isError).toBe(true);
        expect(decision?.veto?.output).toContain('current plan file');
        expect(decision?.veto?.output).toContain('ExitPlanMode');
        expect(formatDenyMessage).toHaveBeenCalledWith(
          expect.stringContaining(PLAN_PATH),
        );
        expect(permissionRan).toBe(false);
      },
    );

    it('blocks Write and Edit with no file write access while plan mode is active', async () => {
      await enterPlan();

      for (const toolName of ['Write', 'Edit'] as const) {
        const decision = await run(
          hookContext(toolName, { args: {}, accesses: ToolAccesses.none() }),
        );
        expect(decision?.veto?.isError).toBe(true);
      }
      expect(permissionRan).toBe(false);
    });

    it('blocks mixed plan-file and non-plan-file write accesses', async () => {
      await enterPlan();
      const decision = await run(
        hookContext('Edit', {
          args: { path: PLAN_PATH },
          accesses: [
            { kind: 'file', operation: 'readwrite', path: PLAN_PATH },
            { kind: 'file', operation: 'write', path: '/workspace/src/main.ts' },
          ],
        }),
      );

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('current plan file');
      expect(permissionRan).toBe(false);
    });

    it('blocks TaskStop while plan mode is active', async () => {
      await enterPlan();
      const decision = await run(hookContext('TaskStop', { args: { task_id: 'bash-abc12345' } }));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('TaskStop');
      expect(decision?.veto?.output).toContain('ExitPlanMode');
      expect(permissionRan).toBe(false);
    });

    it.each(['AgentRun', 'AgentSwarm', 'AgentSend'] as const)(
      'blocks %s while plan mode is active',
      async (toolName) => {
        await enterPlan();
        const decision = await run(hookContext(toolName, { args: {} }));

        expect(decision?.veto?.isError).toBe(true);
        expect(decision?.veto?.output).toContain(toolName);
        expect(decision?.veto?.output).toContain('ExitPlanMode');
        expect(permissionRan).toBe(false);
      },
    );

    it.each(['CronCreate', 'CronDelete'] as const)(
      'blocks %s while plan mode is active',
      async (toolName) => {
        await enterPlan();
        const decision = await run(hookContext(toolName, { args: {} }));

        expect(decision?.veto?.isError).toBe(true);
        expect(decision?.veto?.output).toContain(toolName);
        expect(decision?.veto?.output).toContain('plan mode');
        expect(permissionRan).toBe(false);
      },
    );

    it.each(['Read', 'Grep', 'Bash', 'CronList', 'AgentList'] as const)(
      'abstains on %s while plan mode is active',
      async (toolName) => {
        await enterPlan();
        const decision = await run(hookContext(toolName, { args: {} }));

        expect(decision).toBeUndefined();
        expect(permissionRan).toBe(true);
      },
    );

    it('abstains on everything once plan mode has exited', async () => {
      plan();
      const decision = await run(
        hookContext('Write', {
          args: { path: '/workspace/src/main.ts' },
          accesses: ToolAccesses.writeFile('/workspace/src/main.ts'),
        }),
      );

      expect(decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });
  });

  describe('plan file permission allowlist', () => {
    it.each(['Write', 'Edit'] as const)(
      'approves %s only when every write access targets the active plan file',
      async (toolName) => {
        const svc = await enterPlan();
        const policy = new PlanFileWriteApprovePolicy(svc);

        await expect(policy.evaluate(hookContext(toolName, {
          args: { path: PLAN_PATH },
          accesses: ToolAccesses.writeFile(PLAN_PATH),
        }))).resolves.toEqual({ kind: 'approve' });
        await expect(policy.evaluate(hookContext(toolName, {
          args: { path: PLAN_PATH },
          accesses: [
            { kind: 'file', operation: 'write', path: PLAN_PATH },
            { kind: 'file', operation: 'write', path: '/workspace/src/main.ts' },
          ],
        }))).resolves.toBeUndefined();
      },
    );
  });

  describe('enter plan mode review', () => {
    it('uses the configured gated default and preserves the approval over later permission passes', async () => {
      const svc = plan();
      const decision = await run(
        hookContext('EnterPlanMode', { display: planEnterDisplay() }),
      );

      expect(svc.planGate).toBe('gated');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.origin).toBe('enter-plan-mode-review-ask');
      expect(permissionRan).toBe(true);
      expect(decision?.executionMetadata).toEqual({ planEnterApproved: true });
    });

    it.each([
      ['missing', undefined],
      ['malformed', { kind: 'generic', summary: 'Enter plan mode', detail: {} }],
    ] as const)(
      'blocks gated enter when the approval display is $0',
      async (_name, display) => {
        plan();
        const decision = await run(
          hookContext('EnterPlanMode', { display }),
        );

        expect(requests).toHaveLength(0);
        expect(decision?.veto).toMatchObject({
          isError: true,
          output: expect.stringContaining('approval display'),
        });
        expect(permissionRan).toBe(true);
      },
    );

    it('skips enter approval when the prompt override sets the gate to free', async () => {
      plan().setGate('free');
      const decision = await run(
        hookContext('EnterPlanMode', { display: planEnterDisplay() }),
      );

      expect(requests).toHaveLength(0);
      expect(decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });

    it('skips enter approval in auto permission mode even when gated', async () => {
      plan();
      mode = 'auto';
      const decision = await run(
        hookContext('EnterPlanMode', { display: planEnterDisplay() }),
      );

      expect(requests).toHaveLength(0);
      expect(decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });

    it('returns a model-readable reason when enter approval is rejected', async () => {
      const svc = plan();
      approvalResponse = { decision: 'rejected', feedback: 'Use direct edits.' };
      const decision = await run(
        hookContext('EnterPlanMode', { display: planEnterDisplay() }),
      );

      expect(decision?.veto).toMatchObject({
        isError: true,
        output: expect.stringContaining('user rejected'),
      });
      expect(decision?.veto?.output).toContain('Use direct edits.');
      expect(await svc.status()).toBeNull();
    });

    it('automatically rejects enter approval after the configured timeout', async () => {
      const svc = plan();
      vi.useFakeTimers();
      requestToolApproval.mockImplementation(async (context, ask, origin) => {
        requests.push({ ask, origin });
        return new Promise((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => resolve(mapResolution(ask.resolveError?.(context.signal.reason))),
            { once: true },
          );
        });
      });

      try {
        const pending = run(
          hookContext('EnterPlanMode', { display: planEnterDisplay() }),
        );
        await vi.advanceTimersByTimeAsync(5000);
        const decision = await pending;

        expect(decision?.veto).toMatchObject({
          isError: true,
          output: expect.stringContaining('approval timed out after 5000 ms'),
        });
        expect(await svc.status()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('exit plan mode review', () => {
    it('skips exit approval when the prompt override sets the gate to free', async () => {
      const svc = await enterPlan();
      svc.setGate('free');
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(requests).toHaveLength(0);
      expect(decision).toBeUndefined();
      expect(permissionRan).toBe(true);
      expect(await svc.status()).not.toBeNull();
    });

    it('asks through toolApproval under the legacy origin and tracks plan_submitted', async () => {
      await enterPlan();
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]?.origin).toBe('exit-plan-mode-review-ask');
      expect(requests[0]?.ask.kind).toBe('ask');
      expect(requests[0]?.ask.reason).toEqual({ has_options: false });
      expect(records).toContainEqual({
        event: 'plan_submitted',
        properties: { has_options: false },
      });
      expect(decision?.veto).toBeDefined();
    });

    it('approves with the chosen option prefix and tracks the chosen option', async () => {
      const svc = await enterPlan();
      approvalResponse = { decision: 'approved', selectedLabel: 'Approach B' };
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay({ options }) }),
      );

      expect(decision?.veto?.isError).toBe(false);
      expect(decision?.veto?.output).toContain(
        'Selected approach: Approach B',
      );
      expect(decision?.veto?.output).toContain(
        'Execute ONLY the selected approach',
      );
      expect(decision?.veto?.output).toContain('## Approved Plan:\n# Plan');
      expect(records).toContainEqual({
        event: 'plan_submitted',
        properties: { has_options: true },
      });
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'approved', chosen_option: 'Approach B' },
      });
      expect(await svc.status()).toBeNull();
    });

    it('approves without a selected label and saves the plan path into the output', async () => {
      const svc = await enterPlan();
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(decision?.veto?.output).toContain(
        `Plan saved to: ${PLAN_PATH}`,
      );
      expect(decision?.veto?.output).not.toContain('Selected approach:');
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'approved' },
      });
      expect(await svc.status()).toBeNull();
    });

    it('omits the saved-to line when the display has no path', async () => {
      await enterPlan();
      const decision = await run(
        hookContext('ExitPlanMode', {
          display: planReviewDisplay({ plan: '# Draft Plan', path: undefined }),
        }),
      );

      expect(decision?.veto?.output).toContain('## Approved Plan:\n# Draft Plan');
      expect(decision?.veto?.output).not.toContain('Plan saved to:');
    });

    it('exits plan mode with a stopping error result when the user chooses Reject and Exit', async () => {
      const svc = await enterPlan();
      approvalResponse = { decision: 'rejected', selectedLabel: 'Reject and Exit' };
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(decision?.veto).toMatchObject({
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode deactivated.',
      });
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'rejected_and_exited' },
      });
      expect(await svc.status()).toBeNull();
    });

    it('keeps plan mode active with the feedback result when the user requests revisions', async () => {
      const svc = await enterPlan();
      approvalResponse = {
        decision: 'rejected',
        selectedLabel: 'Revise',
        feedback: 'Add verification.',
      };
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(decision?.veto?.isError).toBe(false);
      expect(decision?.veto?.output).toContain('Add verification.');
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'revise', has_feedback: true },
      });
      expect(await svc.status()).not.toBeNull();
    });

    it('keeps plan mode active with a stopping error result when the user rejects the plan', async () => {
      const svc = await enterPlan();
      approvalResponse = { decision: 'rejected' };
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(decision?.veto).toMatchObject({
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      });
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'rejected' },
      });
      expect(await svc.status()).not.toBeNull();
    });

    it('keeps plan mode active with a dismissed result when the approval is cancelled', async () => {
      const svc = await enterPlan();
      approvalResponse = { decision: 'cancelled' };
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(decision?.veto).toMatchObject({
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      });
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'dismissed' },
      });
      expect(await svc.status()).not.toBeNull();
    });

    it('does not auto-resolve exit approval after the enter timeout window', async () => {
      vi.useFakeTimers();
      const svc = await enterPlan();
      let release: (() => void) | undefined;
      requestToolApproval.mockImplementation(async (_context, ask, origin) => {
        requests.push({ ask, origin });
        return new Promise((resolve) => {
          release = () => resolve(mapResolution(ask.resolveApproval?.(approvalResponse)));
        });
      });

      try {
        const pending = run(
          hookContext('ExitPlanMode', { display: planReviewDisplay() }),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(await svc.status()).not.toBeNull();

        approvalResponse = { decision: 'rejected' };
        release?.();
        await pending;
        expect(await svc.status()).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips the review in auto mode', async () => {
      mode = 'auto';
      await enterPlan();
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(requests).toHaveLength(0);
      expect(records).toEqual([]);
      expect(decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });

    it('skips the review when no plan is active', async () => {
      plan();
      const decision = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(requests).toHaveLength(0);
      expect(decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });

    it.each([
      ['empty', planReviewDisplay({ plan: '   ' })],
      ['wrong kind', { kind: 'generic', summary: 'Presenting plan', detail: {} }],
      ['malformed', { kind: 'plan_review', plan: 42 } as unknown as ToolInputDisplay],
      ['missing', undefined],
    ] as const)(
      'blocks gated exit when the approval display is %s',
      async (_name, display) => {
        await enterPlan();
        const decision = await run(
          hookContext('ExitPlanMode', { display }),
        );

        expect(requests).toHaveLength(0);
        expect(decision?.veto).toMatchObject({
          isError: true,
          output: expect.stringContaining('approval display'),
        });
        expect(permissionRan).toBe(true);
      },
    );
  });
});

describe('EnterPlanModeReview timeout cleanup', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionStateService, new SessionStateService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    ix.set(ISessionApprovalService, new SyncDescriptor(SessionApprovalService));
    ix.get(ISessionInteractionService).acquireConsumer('test-consumer');
  });

  afterEach(() => disposables.dispose());

  it('cancels its real pending approval on timeout and ignores a late response', async () => {
    const approval = ix.get(ISessionApprovalService);
    const interaction = ix.get(ISessionInteractionService);
    const toolApproval: IAgentToolApprovalService = {
      _serviceBrand: undefined,
      resolvePermissionResolution: async () => {
        throw new Error('resolvePermissionResolution is not used');
      },
      requestToolApproval: async (context, ask, _origin, approvalId) => {
        const request = approval.request({
          id: approvalId,
          turnId: context.turnId,
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          action: context.execution.description ?? context.toolCall.name,
          display: context.execution.display ?? planEnterDisplay(),
        });
        try {
          const response = await abortable(request, context.signal);
          return mapResolution(ask.resolveApproval?.(response));
        } catch (error) {
          return mapResolution(ask.resolveError?.(error));
        }
      },
      formatDenyMessage: (message) => message,
      formatApprovalRejectionMessage: () => '',
    };
    const review = new EnterPlanModeReview(toolApproval, approval, 5000);
    const resolved = vi.fn();
    const subscription = interaction.onDidResolve(resolved);
    let planActive = false;

    vi.useFakeTimers();
    try {
      const pending = review.requestApproval(
        hookContext('EnterPlanMode', { display: planEnterDisplay() }),
      );
      expect(approval.listPending()).toHaveLength(1);
      const approvalId = approval.listPending()[0]!.id!;

      await vi.advanceTimersByTimeAsync(5000);
      const decision = await pending;
      if (decision?.veto === undefined) planActive = true;

      expect(approval.listPending()).toEqual([]);
      expect(resolved).toHaveBeenCalledWith({
        id: approvalId,
        response: { decision: 'cancelled' },
      });
      expect(decision?.veto).toMatchObject({
        isError: true,
        output: expect.stringContaining('approval timed out after 5000 ms'),
      });
      expect(planActive).toBe(false);

      approval.decide(approvalId, { decision: 'approved' });
      expect(approval.listPending()).toEqual([]);
      expect(resolved).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      subscription.dispose();
    }
  });
});
