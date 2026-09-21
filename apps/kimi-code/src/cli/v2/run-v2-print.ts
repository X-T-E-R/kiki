/** `kiki -p`: one writer and background-policy loop over the shared client facade. */
import { readFile } from 'node:fs/promises';

import {
  createPrintClient,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  parseAgentFileText,
  resolveAgentPath,
  resolveKikiHome,
  setClampedTimeout,
  type AgentTaskConfig,
  type PrintBackgroundMode,
} from '@kiki/node-sdk';
import type { AgentEventPayloads, AgentHandle, EventSubscription, Klient, SessionHandle } from '@kiki/klient';
import { createKimiDefaultHeaders } from '@kiki/oauth';

import { resolve } from 'pathe';

import { CLI_SHUTDOWN_TIMEOUT_MS, PROMPT_CLEANUP_TIMEOUT_MS } from '#/constant/app';

import {
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
  type HeadlessGoalCreate,
} from '../goal-prompt';
import {
  type PromptRunIO,
  configuredModel,
  installPromptTerminationCleanup,
  raceWithTimeout,
  requireConfiguredModel,
} from '../run-prompt';
import { createKimiCodeHostIdentity } from '../version';

import { resolveOutputFormat } from '../options';
import type { CLIOptions, PromptOutputFormat } from '../options';
import {
  type PromptOutput,
  PromptJsonWriter,
  type PromptTurnWriter,
  PromptTranscriptWriter,
  writeExperimentalVersion,
  writeResumeHint,
} from '../prompt-render';

type AssistantDelta = AgentEventPayloads['assistant.delta'];
type ThinkingDelta = AgentEventPayloads['thinking.delta'];
type ToolCallDelta = AgentEventPayloads['tool.call.delta'];
type TurnStepRetrying = AgentEventPayloads['turn.step.retrying'];
type HookResult = AgentEventPayloads['hook.result'];
type ToolCallStarted = AgentEventPayloads['tool.call.started'];
type ToolProgress = AgentEventPayloads['tool.progress'];
type ToolResultEvent = AgentEventPayloads['tool.result'];
type TurnEnded = AgentEventPayloads['turn.ended'];
type PrintEvent = AgentEventPayloads[keyof AgentEventPayloads];
type TerminalReceipt = Awaited<ReturnType<AgentHandle['prompt']>>;
/** Re-check `goalActive` at least this often while waiting for goal turns. */
const GOAL_WAIT_POLL_MS = 250;
/**
 * Slack on top of a scheduled cron fire time while waiting for the steered
 * turn: covers the 1s tick poll interval plus fire → inject → turn-launch
 * latency.
 */
const CRON_FIRE_GRACE_MS = 5_000;

export async function runV2Print(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const outputFormat = resolveOutputFormat(opts);
  const workDir = process.cwd();

  writeExperimentalVersion(version, outputFormat, stdout, stderr);

  const homeDir = resolveKikiHome();
  const identity = createKimiCodeHostIdentity(version, { homeDir });
  const host = await createPrintClient({
    homeDir,
    clientIdentity: identity,
    args: {
      requestHeaders: createKimiDefaultHeaders({ homeDir, ...identity }),
      skillDirs: opts.skillsDirs,
      agentFiles: opts.agentFiles,
    },
  });
  const klient = host.klient;
  let restorePermission = async (): Promise<void> => {};
  let activeAgent: AgentHandle | undefined;
  let activeSession: SessionHandle | undefined;
  let removeTerminationCleanup: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    const pending = (cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      try {
        await activeAgent?.cancel();
      } finally {
        try {
          await restorePermission();
        } finally {
          // A turn's tail records reach the journal only through the wire
          // service's async persist queue; closing the session and disposing
          // the app must not cut that queue off. Bounded and best-effort: a
          // persist failure must never mask the run's outcome.
          await raceWithTimeout(host.flushWires(), CLI_SHUTDOWN_TIMEOUT_MS).catch(() => {});
          try {
            await activeSession?.close();
          } finally {
            await host.dispose();
          }
        }
      }
    })());
    await raceWithTimeout(pending, PROMPT_CLEANUP_TIMEOUT_MS);
  };
  removeTerminationCleanup = installPromptTerminationCleanup(promptProcess, cleanup);

  try {
    for (const diagnostic of await klient.global.config.diagnostics()) {
      if (diagnostic.severity === 'warning') stderr.write(`Warning: ${diagnostic.message}\n`);
    }
    const resolved = await resolvePrintSession(klient, host.osHomeDir, opts, workDir, stderr);
    restorePermission = resolved.restorePermission;
    activeAgent = resolved.agent;
    activeSession = resolved.session;

    const goalCreate = parseHeadlessGoalCreate(opts.prompt!);
    if (goalCreate !== undefined) {
      await runPrintGoal(klient, resolved.session, resolved.agent, goalCreate, resolved.goalModel, outputFormat, stdout, stderr);
    } else {
      await runPrintTurn(klient, resolved.session, resolved.agent, opts.prompt!, outputFormat, stdout, stderr);
    }
    writeResumeHint(resolved.sessionId, outputFormat, stdout, stderr);
  } finally {
    await cleanup();
  }
}

interface ResolvedPrintSession {
  readonly sessionId: string;
  readonly session: SessionHandle;
  readonly agent: AgentHandle;
  readonly restorePermission: () => Promise<void>;
  readonly goalModel: string | undefined;
}

async function resolvePrintSession(
  klient: Klient,
  osHomeDir: string,
  opts: CLIOptions,
  workDir: string,
  stderr: PromptOutput,
): Promise<ResolvedPrintSession> {
  let agentProfileName = opts.agent;
  const agentFile = opts.agentFiles[0];
  if (agentProfileName === undefined && agentFile !== undefined) {
    const agentFilePath = resolveAgentPath(agentFile, workDir, osHomeDir);
    let agentFileText: string;
    try {
      agentFileText = await readFile(agentFilePath, 'utf8');
    } catch (error) {
      throw new Error(
        `Failed to read agent file "${agentFilePath}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      agentProfileName = parseAgentFileText({ path: agentFilePath, source: 'explicit', text: agentFileText }).name;
    } catch (error) {
      throw new Error(
        `Invalid agent file "${agentFilePath}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const resumeById = async (sessionId: string): Promise<ResolvedPrintSession> => {
    const session = klient.session(sessionId);
    if (!await session.resume()) throw new Error(`Session "${sessionId}" not found.`);
    const agent = session.agent('main');
    if (opts.model !== undefined) await agent.setModel(opts.model);
    if (opts.thinking !== undefined) await agent.setThinking(opts.thinking);
    const currentModel = await agent.getModel();
    const previousPermission = await agent.getPermission();
    await agent.setPermission('auto', { broadcast: false });
    return {
      sessionId, session, agent,
      restorePermission: () => agent.setPermission(previousPermission, { broadcast: false }),
      goalModel: configuredModel(opts.model, currentModel),
    };
  };

  if (opts.session !== undefined) {
    const target = await klient.global.sessions.get(opts.session);
    if (target === undefined) throw new Error(`Session "${opts.session}" not found.`);
    if (target.cwd !== undefined && resolve(target.cwd) !== resolve(workDir)) {
      stderr.write(
        `Session "${opts.session}" was created under a different directory.\n` +
          `  cd "${target.cwd}" && kiki -r ${opts.session}\n\n`,
      );
      throw new Error(`Session "${opts.session}" was created under a different directory.`);
    }
    return resumeById(opts.session);
  }

  if (opts.continue) {
    const page = await klient.global.sessions.list({});
    const previous = page.items.find((summary) => summary.cwd === workDir);
    if (previous !== undefined) return resumeById(previous.id);
    stderr.write(`No sessions to continue under "${workDir}"; starting a fresh session.\n`);
  }

  const created = await klient.global.sessions.create({
    workDir,
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    mainAgentBinding: { profile: agentProfileName ?? 'agent', model: opts.model, thinking: opts.thinking },
  });
  const session = klient.session(created.id);
  const agent = session.agent('main');
  await agent.setPermission('auto', { broadcast: false });
  return { sessionId: created.id, session, agent, restorePermission: async () => {}, goalModel: await agent.getModel() };
}

async function runPrintTurn(
  klient: Klient,
  session: SessionHandle,
  agent: AgentHandle,
  prompt: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  const writer: PromptTurnWriter = outputFormat === 'stream-json'
    ? new PromptJsonWriter(stdout) : new PromptTranscriptWriter(stdout, stderr);
  await klient.global.auth.ensureReady(await agent.getModel());
  const turnEndings = createPrintTurnEndings();
  const subscriptions: EventSubscription[] = [];
  const eventNames = [
    'turn.step.started', 'turn.step.interrupted', 'turn.step.retrying', 'assistant.delta',
    'hook.result', 'thinking.delta', 'tool.call.started', 'tool.call.delta', 'tool.result',
    'tool.progress', 'turn.ended',
  ] as const;
  const errors = agent.events.onError((error) => stderr.write(`Warning: print event delivery failed: ${error.message}\n`));
  try {
    for (const name of eventNames) {
      subscriptions.push(agent.events.on(name, (event) => {
        dispatchPrintEvent(writer, event, stderr);
        if (event.type === 'turn.ended') turnEndings.push(event);
      }));
    }
    await Promise.all(subscriptions.map((subscription) => subscription.ready));
    const receipt = await agent.prompt({ input: [{ type: 'text', text: prompt }] }, { waitFor: 'terminal' });
    if (receipt.turnId === undefined || receipt.result === undefined) {
      throw new Error(receipt.state === 'blocked' ? 'Prompt hook blocked the request.' : 'Prompt turn could not be started');
    }
    writer.flushAssistant();
    if (receipt.result.type !== 'completed') throw new Error(formatPrintTurnFailure(receipt.result));

    const [legacy, current] = await Promise.all([
      klient.global.config.get<AgentTaskConfig | undefined>('background'),
      klient.global.config.get<AgentTaskConfig | undefined>('task'),
    ]);
    const taskConfig = { ...legacy, ...current };
    const ceilingS = taskConfig.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
    try {
      await applyPrintBackgroundPolicy({
        mode: taskConfig.printBackgroundMode ?? (taskConfig.keepAliveOnExit === true ? 'drain' : 'steer'),
        ceilingS,
        maxTurns: taskConfig.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT,
        countPending: () => session.countPendingBackgroundTasks(),
        drain: () => session.drainBackgroundTasks(ceilingS * 1000),
        turnEndings,
        skipTurnId: receipt.turnId,
        warn: (message) => stderr.write(`Warning: ${message}\n`),
        now: () => Date.now(),
        goalActive: async () => (await agent.getGoal()).goal?.status === 'active',
        cronNextFireAt: () => session.nextCronFireAt(),
      });
    } catch (error) {
      if (error instanceof PrintSteeredTurnFailedError) throw error;
      stderr.write(`Warning: print background policy failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  } finally {
    writer.finish();
    for (const subscription of subscriptions) subscription.dispose();
    errors.dispose();
  }
}

async function runPrintGoal(
  klient: Klient,
  session: SessionHandle,
  agent: AgentHandle,
  goal: HeadlessGoalCreate,
  model: string | undefined,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  requireConfiguredModel(model);
  let completedSnapshot: { readonly status: string } | null = null;
  const subscription = agent.events.on('goal.updated', (event) => {
    if (event.change?.kind === 'completion' && event.snapshot !== null) completedSnapshot = event.snapshot;
  });
  let created = false;
  try {
    await subscription.ready;
    await agent.createGoal({ objective: goal.objective, replace: goal.replace });
    created = true;
    await runPrintTurn(klient, session, agent, goal.objective, outputFormat, stdout, stderr);
  } finally {
    subscription.dispose();
    if (created) {
      const snapshot = completedSnapshot ?? (await agent.getGoal()).goal;
      if (outputFormat === 'stream-json') stdout.write(`${JSON.stringify(goalSummaryJson(snapshot))}\n`);
      else stderr.write(`${formatGoalSummaryText(snapshot)}\n`);
      if (snapshot !== null && snapshot.status !== 'complete') process.exitCode = goalExitCode(snapshot.status);
    }
  }
}

function dispatchPrintEvent(
  writer: PromptTurnWriter,
  event: PrintEvent,
  stderr: PromptOutput,
): void {
  switch (event.type) {
    case 'turn.step.started':
    case 'turn.step.interrupted':
      writer.flushAssistant();
      return;
    case 'turn.step.retrying':
      writer.discardAssistant();
      writer.writeRetrying(event as unknown as TurnStepRetrying);
      return;
    case 'assistant.delta':
      writer.writeAssistantDelta((event as unknown as AssistantDelta).delta);
      return;
    case 'hook.result':
      writer.writeHookResult(event as unknown as HookResult);
      return;
    case 'thinking.delta':
      writer.writeThinkingDelta((event as unknown as ThinkingDelta).delta);
      return;
    case 'tool.call.started': {
      const started = event as unknown as ToolCallStarted;
      writer.writeToolCall(started.toolCallId, started.name, started.args);
      return;
    }
    case 'tool.call.delta': {
      const delta = event as unknown as ToolCallDelta;
      writer.writeToolCallDelta(delta.toolCallId, delta.name, delta.argumentsPart);
      return;
    }
    case 'tool.result': {
      const result = event as unknown as ToolResultEvent;
      writer.writeToolResult(result.toolCallId, result.output);
      return;
    }
    case 'tool.progress': {
      const progress = (event as unknown as ToolProgress).update;
      if (progress.text !== undefined && progress.text.length > 0) {
        stderr.write(progress.text.endsWith('\n') ? progress.text : `${progress.text}\n`);
      }
      return;
    }
  }
}

export type PrintTurnEnding = TurnEnded;

/**
 * Source of `turn.ended` events for the print steer loop. `next` resolves with
 * the next ending (skipping `skipTurnId`, the main turn's own buffered
 * ending), or `null` when `remainingMs` elapses first.
 */
export interface PrintTurnEndings {
  next(remainingMs: number, skipTurnId: number): Promise<PrintTurnEnding | null>;
}

/**
 * Buffered `turn.ended` collector fed from the agent event bus. Events that
 * arrive while no one is waiting are queued, so endings that fire between the
 * main turn settling and the policy loop starting are not missed.
 */
export function createPrintTurnEndings(): PrintTurnEndings & {
  push: (event: PrintTurnEnding) => void;
} {
  const buffer: PrintTurnEnding[] = [];
  let waiter: ((ending: PrintTurnEnding | null) => void) | undefined;
  return {
    push: (event) => {
      const resolve = waiter;
      if (resolve !== undefined) {
        waiter = undefined;
        resolve(event);
        return;
      }
      buffer.push(event);
    },
    next: async (remainingMs, skipTurnId) => {
      const deadlineAt = Date.now() + remainingMs;
      const waitOnce = (ms: number): Promise<PrintTurnEnding | null> =>
        new Promise((resolve) => {
          let settled = false;
          const settle = (value: PrintTurnEnding | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiter = undefined;
            // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` guards the single resolve; the rule cannot see it
            resolve(value);
          };
          // A delay beyond the host timer ceiling (an explicit
          // `print_wait_ceiling_s` or a far-future cron fire can still reach
          // it) is clamped by `setClampedTimeout`, so the timer can expire
          // early: the loop below treats that as a chunk boundary and
          // re-arms against the real deadline.
          const timer = Number.isFinite(ms)
            ? setClampedTimeout(() => {
                settle(null);
              }, ms)
            : undefined;
          waiter = settle;
        });
      for (;;) {
        while (buffer.length > 0) {
          const ending = buffer.shift()!;
          if (ending.turnId !== skipTurnId) return ending;
        }
        const ms = deadlineAt - Date.now();
        if (ms <= 0) return null;
        const ending = await waitOnce(ms);
        // Timer-chunk boundary, not the real deadline: keep waiting.
        if (ending === null) continue;
        if (ending.turnId !== skipTurnId) return ending;
        // The skipped turn's own ending: keep waiting within the same budget.
      }
    },
  };
}

/** A background-task completion steered a new main turn that did not complete. */
export class PrintSteeredTurnFailedError extends Error {}

export interface PrintBackgroundPolicyInput {
  readonly mode: PrintBackgroundMode;
  readonly ceilingS: number;
  readonly maxTurns: number;
  readonly countPending: () => number | Promise<number>;
  readonly drain: () => Promise<void>;
  readonly turnEndings: PrintTurnEndings;
  readonly skipTurnId: number;
  readonly warn: (message: string) => void;
  readonly now: () => number;
  /** Keep waiting for active goal continuations regardless of background mode. */
  readonly goalActive?: () => boolean | Promise<boolean>;
  /** Next cron fire (epoch ms), or null. Cron liveness applies under exit/drain too. */
  readonly cronNextFireAt?: () => number | null | Promise<number | null>;
}

/**
 * Apply the print-mode (`kimi -p`) background-resource policy after the main
 * turn completes. A single loop re-evaluates the Session's live resources in
 * order on every round and stays alive while any of them is pending:
 *  - goal    : while a goal is `active`, keep waiting for its continuation
 *              turns (bounded by `ceilingS` as a safety net), regardless of
 *              the background mode; the goal summary drives the exit code.
 *  - cron    : while `cronNextFireAt` reports a future fire, keep waiting —
 *              the cron tick timer is unref'd, so the process must hold the
 *              event loop itself (v1 parity, independent of the mode). The
 *              fire steers a new turn; a steered turn that does not complete
 *              fails the run. Each round re-reads the next fire time, so a
 *              fired one-shot task ends the wait while a recurring one keeps
 *              it. A fire time that stays unchanged and in the past across
 *              two consecutive rounds means the tick is wedged: warn once and
 *              stop cron waiting instead of spinning.
 *  - mode    : 'exit'  → return immediately;
 *              'drain' → suppress + drain background tasks, then return;
 *              'steer' → while background tasks are still pending, stay alive
 *              so task completions steer new main turns; return once
 *              quiescent, or when the wall-clock ceiling (`ceilingS`) or the
 *              turn cap (`maxTurns`) is reached. A steered turn that does not
 *              complete fails the run.
 * The steer ceiling deadline is set once on entry, so goal/cron waiting
 * consumes the same budget.
 */
export async function applyPrintBackgroundPolicy(
  input: PrintBackgroundPolicyInput,
): Promise<void> {
  const deadline = input.now() + input.ceilingS * 1000;
  let turns = 0;
  // Cron anti-spin guard: the last fire time seen already in the past. Two
  // consecutive rounds with the same past fire time mean the tick never ran.
  let lastPastFireAt: number | undefined;
  let cronWedged = false;
  for (;;) {
    // (a) goal: while a goal is `active`, keep waiting for its continuation
    // turns. Also wake on a short poll: a goal can leave `active` without any
    // further turn.ended (budget block at a turn boundary, or a pause after a
    // continuation-launch failure), which would otherwise hang the run until
    // the ceiling. A continuation turn that does not complete pauses/blocks
    // the goal, so the condition exits on the next check.
    while (await input.goalActive?.() === true) {
      const ended = await input.turnEndings.next(
        Math.min(deadline - input.now(), GOAL_WAIT_POLL_MS),
        input.skipTurnId,
      );
      if (ended === null && input.now() >= deadline) {
        input.warn(`print goal wait ceiling reached (${input.ceilingS}s), finishing`);
        return;
      }
    }

    // (b) cron: keep the process alive until the pending fire steered a turn
    // (one-shot tasks vanish after firing; recurring ones advance their next
    // fire), then re-evaluate from the top.
    if (!cronWedged && input.cronNextFireAt !== undefined) {
      const fireAt = await input.cronNextFireAt();
      if (fireAt !== null) {
        if (fireAt <= input.now() && lastPastFireAt === fireAt) {
          cronWedged = true;
          input.warn(
            'print cron wait: next fire time stuck in the past; cron tick appears wedged, giving up on cron',
          );
        } else {
          if (fireAt <= input.now()) lastPastFireAt = fireAt;
          const ended = await input.turnEndings.next(
            Math.max(fireAt - input.now(), 0) + CRON_FIRE_GRACE_MS,
            input.skipTurnId,
          );
          if (ended !== null && ended.reason !== 'completed') {
            throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
          }
          // Fire observed (or its grace elapsed without a turn): re-read the
          // next fire time from the top.
          continue;
        }
      }
    }

    // (c) background-task mode.
    if (input.mode === 'exit') return;
    if (input.mode === 'drain') {
      await input.drain();
      return;
    }

    // 'steer'
    turns += 1;
    if (input.now() >= deadline) {
      input.warn(`print steer ceiling reached (${input.ceilingS}s), finishing`);
      return;
    }
    if (turns > input.maxTurns) {
      input.warn(`print steer max turns reached (${input.maxTurns}), finishing`);
      return;
    }
    if (await input.countPending() === 0) return;
    const ended = await input.turnEndings.next(deadline - input.now(), input.skipTurnId);
    if (ended === null) return;
    if (ended.reason !== 'completed') {
      throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
    }
  }
}

function formatTurnEndingFailure(ending: PrintTurnEnding): string {
  const error = ending.error as { code: string; message: string } | undefined;
  if (error?.code === 'provider.filtered') return 'Provider safety policy blocked the response.';
  if (error !== undefined) return `${error.code}: ${error.message}`;
  if (ending.reason === 'blocked') return 'Prompt hook blocked the request.';
  return `Prompt turn ended with reason: ${ending.reason}`;
}

function formatPrintTurnFailure(result: NonNullable<TerminalReceipt['result']>): string {
  if (result.type === 'failed') {
    if (result.error.code === 'provider.filtered') return 'Provider safety policy blocked the response.';
    if (result.error.code === 'internal' && result.error.name === 'Error') return result.error.message;
    return `${result.error.code}: ${result.error.message}`.trimEnd();
  }
  return `Prompt turn ended with reason: ${result.type}`;
}
