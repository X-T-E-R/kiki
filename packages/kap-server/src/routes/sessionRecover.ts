import { randomUUID } from 'node:crypto';
import {
  IAgentExecutionService,
  IAgentLifecycleService,
  IAgentPromptService,
  IAgentStateService,
  IAgentTaskService,
  IEventService,
  ISessionMetadata,
  MAIN_AGENT_ID,
  type AgentTaskInfo,
  type Scope,
} from '@kiki/agent-core-v2';
import { hasUnfinishedTurn, turnKey } from '@kiki/agent-core-v2/agent/loop/turnOps';
import { currentRuntimeBootId } from '@kiki/agent-core-v2/session/sessionActivity/sessionOutcomeMirrorService';
import { SessionMetaUpdated } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetaEvents';
import type { SessionInterruptedWork as CoreSessionInterruptedWork } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import {
  ErrorCode,
  recoverSessionRequestSchema,
  recoverSessionResponseSchema,
  type SessionInterruptedTarget,
  type SessionInterruptedWork,
} from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { ensureSessionAgent } from '../lib/sessionAgent';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { mapError } from '../transport/errors';

interface RecoverRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: { id: string; params: unknown; body: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>,
  ): unknown;
}

/** Projects persisted or cold-boot-stale interruption metadata onto the wire `Session.interrupted_work` field without scanning wire logs. */
export function toWireInterruptedWork(
  fields: {
    readonly updatedAt: number;
    readonly interruptedWork?: CoreSessionInterruptedWork;
    readonly activeRunBootId?: string;
  },
  busy: boolean,
): SessionInterruptedWork | undefined {
  if (busy) return undefined;
  if (fields.interruptedWork !== undefined) {
    return {
      interrupted_at: new Date(fields.interruptedWork.interruptedAt).toISOString(),
      main_interrupted: fields.interruptedWork.mainInterrupted,
      lost_tasks: fields.interruptedWork.lostTasks,
      interrupted_branches: fields.interruptedWork.interruptedBranches,
      targets: fields.interruptedWork.targets?.map((target) => ({
        agent_id: target.agentId,
        label: target.label,
        kind: target.kind,
        reason: target.reason,
        lost_tasks: target.lostTasks,
      })),
    };
  }
  if (fields.activeRunBootId !== undefined && fields.activeRunBootId !== currentRuntimeBootId()) {
    return {
      interrupted_at: new Date(fields.updatedAt).toISOString(),
      main_interrupted: true,
    };
  }
  return undefined;
}

function buildRecoveryReminderBody(
  targetAgentId: string,
  targets: readonly SessionInterruptedTarget[],
  lostTasks: readonly AgentTaskInfo[],
): string {
  const lines: string[] = [
    'The Kiki host process restarted while work in this session was in flight, so execution was interrupted before completion.',
    `Resume your pending work on agent "${targetAgentId}" cleanly from the current disk/workspace state without asking the user to repeat instructions.`,
  ];
  const mainTarget = targets.find((target) => target.agent_id === targetAgentId && target.reason === 'recovery');
  if (mainTarget !== undefined) {
    lines.push('- Your previous turn was interrupted mid-flight (`recovery`). Check what was already written or committed before continuing.');
  }
  if (lostTasks.length > 0) {
    lines.push('- Interrupted background/subagent tasks (`status: lost`):');
    for (const task of lostTasks.slice(0, 12)) {
      const ownerPart = task.kind === 'agent' && task.agentId !== undefined ? ` agent=${task.agentId}` : '';
      lines.push(`  - task=${task.taskId} kind=${task.kind}${ownerPart} description="${task.description}"`);
    }
    if (lostTasks.length > 12) {
      lines.push(`  - ...and ${lostTasks.length - 12} more lost task(s)`);
    }
    lines.push('  Inspect preserved output/files first and resume the same child agent with `AgentRun(resume=...)` where needed instead of duplicating finished steps.');
  }
  const interruptedBranches = targets.filter((target) => target.kind === 'branch' && target.agent_id !== targetAgentId);
  if (interruptedBranches.length > 0) {
    lines.push('- Interrupted unsealed branch(es):');
    for (const branch of interruptedBranches.slice(0, 8)) {
      const labelPart = branch.label !== undefined ? ` (${branch.label})` : '';
      const lostPart = branch.lost_tasks !== undefined && branch.lost_tasks > 0 ? ` [${branch.lost_tasks} lost child task(s)]` : '';
      lines.push(`  - branch=${branch.agent_id}${labelPart}${lostPart}`);
    }
  }
  return lines.join('\n');
}

const MAX_RECOVERED_LOST_TASK_IDS = 256;
const activeRecoverBySession = new Map<string, Set<string>>();

function mergeRecoveredLostTaskIds(
  existing: readonly string[] | undefined,
  newlyAcknowledged: readonly AgentTaskInfo[],
): readonly string[] | undefined {
  if (newlyAcknowledged.length === 0) return existing;
  const merged = new Set<string>(existing ?? []);
  for (const task of newlyAcknowledged) merged.add(task.taskId);
  const list = [...merged];
  return list.length > MAX_RECOVERED_LOST_TASK_IDS ? list.slice(-MAX_RECOVERED_LOST_TASK_IDS) : list;
}

/** Registers `POST /sessions/{session_id}/recover` to wake interrupted turns, lost subagent tasks, or unsealed branches idempotently without duplicating user prompts. */
export function registerSessionRecoverRoute(app: RecoverRouteHost, core: Scope): void {
  const params = z.object({ session_id: z.string().min(1) });
  const recoverRoute = defineRoute({
    method: 'POST',
    path: '/sessions/{session_id}/recover',
    params,
    body: recoverSessionRequestSchema,
    success: { data: recoverSessionResponseSchema },
    errors: {
      [ErrorCode.SESSION_NOT_FOUND]: {},
      [ErrorCode.VALIDATION_FAILED]: {},
    },
    description: 'Idempotently resume interrupted work after a host restart without duplicating user prompts',
    tags: ['sessions'],
  }, async (req, reply) => {
    const sessionId = req.params.session_id;
    const targetAgentId = req.body.agent_id ?? MAIN_AGENT_ID;
    let inFlightTargets = activeRecoverBySession.get(sessionId);
    if (inFlightTargets?.has(targetAgentId)) {
      reply.send(
        okEnvelope(
          {
            session_id: sessionId,
            agent_id: targetAgentId,
            status: 'already_running' as const,
            recovered_targets: [],
          },
          req.id,
        ),
      );
      return;
    }
    if (inFlightTargets === undefined) {
      inFlightTargets = new Set<string>();
      activeRecoverBySession.set(sessionId, inFlightTargets);
    }
    inFlightTargets.add(targetAgentId);
    try {
      await withSessionOperation(core, sessionId, async (session) => {
        if (session === undefined) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, req.id));
          return;
        }
        const agent = await ensureSessionAgent(core, session, targetAgentId);
        const lifecycle = session.accessor.get(IAgentLifecycleService);
        const metadata = session.accessor.get(ISessionMetadata);
        const meta = await metadata.read();
        const staleBoot = meta.activeRunBootId !== undefined && meta.activeRunBootId !== currentRuntimeBootId();
        const recoveryWatermark = meta.lastRecoveredAt ?? 0;
        const acknowledgedLostTaskIds = new Set(meta.recoveredLostTaskIds ?? []);
        const staleRunAgents = new Set(staleBoot ? (meta.activeRunAgentIds ?? []) : []);
        const persistedTargetIds = new Set((meta.interruptedWork?.targets ?? []).map((entry) => entry.agentId));

        if (targetAgentId === MAIN_AGENT_ID) {
          for (const [id, agentMeta] of Object.entries(meta.agents ?? {})) {
            if (id === MAIN_AGENT_ID) continue;
            if (agentMeta.labels?.['branch'] !== 'true' || agentMeta.labels?.['branchSealed'] === 'true') continue;
            if (lifecycle.get(id) !== undefined) continue;
            if (staleBoot || staleRunAgents.has(id) || persistedTargetIds.has(id) || agentMeta.branchTurn?.outcome === 'cancelled') {
              await ensureSessionAgent(core, session, id).catch(() => undefined);
            }
          }
        }

        await Promise.all(
          lifecycle.list().map(async (handle) => {
            await handle.accessor.get(IAgentTaskService).resumeRestoration?.();
          }),
        );
        const execution = agent.accessor.get(IAgentExecutionService);
        const prompts = agent.accessor.get(IAgentPromptService);
        const queue = prompts.list();
        const execStatus = execution.status().state;
        if (
          execStatus === 'starting' ||
          execStatus === 'running' ||
          execStatus === 'cancelling' ||
          queue.active !== undefined ||
          queue.launching !== undefined
        ) {
          reply.send(
            okEnvelope(
              {
                session_id: sessionId,
                agent_id: targetAgentId,
                status: 'already_running' as const,
                recovered_targets: [],
              },
              req.id,
            ),
          );
          return;
        }

        const targets: SessionInterruptedTarget[] = [];
        const seenTargets = new Set<string>();
        const addTarget = (target: SessionInterruptedTarget): void => {
          if (seenTargets.has(target.agent_id)) return;
          seenTargets.add(target.agent_id);
          targets.push(target);
        };

        const states = agent.accessor.get(IAgentStateService);
        const turnState = states.has(turnKey) ? states.get(turnKey) : undefined;
        const targetMeta = meta.agents?.[targetAgentId];
        const targetKind: SessionInterruptedTarget['kind'] =
          targetAgentId === MAIN_AGENT_ID
            ? 'main'
            : targetMeta?.labels?.['branch'] === 'true'
              ? 'branch'
              : 'subagent';
        const targetHasUnfinished = hasUnfinishedTurn(turnState);
        if (targetHasUnfinished) {
          addTarget({
            agent_id: targetAgentId,
            label: targetMeta?.userLabel ?? targetMeta?.displayName,
            kind: targetKind,
            reason: 'recovery',
          });
        }

        const lostTasks: AgentTaskInfo[] = [];
        const seenTaskIds = new Set<string>();
        const lostByOwner = new Map<string, number>();
        const handlesToScan = targetAgentId === MAIN_AGENT_ID ? lifecycle.list() : [agent];
        for (const handle of handlesToScan) {
          const taskService = handle.accessor.get(IAgentTaskService);
          for (const task of taskService.list(false)) {
            if (task.status !== 'lost' || seenTaskIds.has(task.taskId)) continue;
            if (acknowledgedLostTaskIds.has(task.taskId)) continue;
            if ((task.endedAt ?? task.startedAt) < recoveryWatermark) continue;
            seenTaskIds.add(task.taskId);
            lostTasks.push(task);
            lostByOwner.set(handle.id, (lostByOwner.get(handle.id) ?? 0) + 1);
            if (task.kind === 'agent' && task.agentId !== undefined && task.agentId !== targetAgentId) {
              const childMeta = meta.agents?.[task.agentId];
              const isBranch = childMeta?.labels?.['branch'] === 'true';
              addTarget({
                agent_id: task.agentId,
                label: childMeta?.userLabel ?? childMeta?.displayName ?? task.description,
                kind: isBranch ? 'branch' : 'subagent',
                reason: isBranch ? 'branch_interrupted' : 'lost_task',
              });
            }
          }
        }
        const targetOwnedLostCount = lostByOwner.get(targetAgentId) ?? 0;
        if (targetOwnedLostCount > 0 && !seenTargets.has(targetAgentId)) {
          addTarget({
            agent_id: targetAgentId,
            label: targetMeta?.userLabel ?? targetMeta?.displayName,
            kind: targetKind,
            reason: 'lost_task',
            lost_tasks: targetOwnedLostCount,
          });
        }

        const interruptedBranchIds: string[] = [];
        if (targetAgentId === MAIN_AGENT_ID) {
          for (const [id, agentMeta] of Object.entries(meta.agents ?? {})) {
            if (id === MAIN_AGENT_ID) continue;
            if (agentMeta.labels?.['branch'] !== 'true' || agentMeta.labels?.['branchSealed'] === 'true') continue;
            const branchLost = lostByOwner.get(id) ?? 0;
            const branchCancelled =
              agentMeta.branchTurn?.outcome === 'cancelled' && agentMeta.branchTurn.endedAt >= recoveryWatermark;
            const branchHandle = lifecycle.get(id);
            const branchStates = branchHandle?.accessor.get(IAgentStateService);
            const branchTurnState = branchStates?.has(turnKey) ? branchStates.get(turnKey) : undefined;
            const branchUnfinished = hasUnfinishedTurn(branchTurnState);
            const branchRunningAtCrash = staleRunAgents.has(id);
            if (branchLost > 0 || branchCancelled || branchUnfinished || branchRunningAtCrash) {
              interruptedBranchIds.push(id);
              addTarget({
                agent_id: id,
                label: agentMeta.userLabel ?? agentMeta.displayName,
                kind: 'branch',
                reason: 'branch_interrupted',
                lost_tasks: branchLost > 0 ? branchLost : undefined,
              });
            }
          }
        }

        if (meta.interruptedWork?.targets !== undefined) {
          for (const persisted of meta.interruptedWork.targets) {
            if (targetAgentId !== MAIN_AGENT_ID && persisted.agentId !== targetAgentId) continue;
            if (persisted.kind === 'branch' && !interruptedBranchIds.includes(persisted.agentId)) {
              const branchMeta = meta.agents?.[persisted.agentId];
              if (branchMeta?.labels?.['branch'] === 'true' && branchMeta.labels?.['branchSealed'] !== 'true') {
                interruptedBranchIds.push(persisted.agentId);
              }
            }
            addTarget({
              agent_id: persisted.agentId,
              label: persisted.label,
              kind: persisted.kind,
              reason: persisted.reason,
              lost_tasks: persisted.lostTasks,
            });
          }
        }
        if (
          targets.length === 0 &&
          targetAgentId === MAIN_AGENT_ID &&
          (meta.interruptedWork !== undefined || staleBoot)
        ) {
          addTarget({
            agent_id: MAIN_AGENT_ID,
            kind: 'main',
            reason: 'recovery',
          });
        }

        const hasRecoveryHold = queue.hold?.reason === 'recovery';
        if (targets.length === 0 && !hasRecoveryHold) {
          if (meta.interruptedWork !== undefined || staleBoot) {
            await metadata.update(
              { interruptedWork: undefined, activeRunBootId: undefined, activeRunAgentIds: undefined },
              { touchUpdatedAt: false },
            );
            core.accessor.get(IEventService).publish(
              new SessionMetaUpdated({
                payload: { agentId: MAIN_AGENT_ID, sessionId, patch: {} },
              }),
            );
          }
          reply.send(
            okEnvelope(
              {
                session_id: sessionId,
                agent_id: targetAgentId,
                status: 'nothing_to_recover' as const,
                recovered_targets: [],
              },
              req.id,
            ),
          );
          return;
        }

        const branchOnlyRecovery =
          targetAgentId === MAIN_AGENT_ID &&
          !targetHasUnfinished &&
          targetOwnedLostCount === 0 &&
          !hasRecoveryHold &&
          meta.interruptedWork?.mainInterrupted !== true &&
          interruptedBranchIds.length > 0;

        let promptId: string | undefined;
        let wokeAny = false;
        if (branchOnlyRecovery) {
          for (const branchId of interruptedBranchIds) {
            const branchHandle = lifecycle.get(branchId) ?? (await ensureSessionAgent(core, session, branchId).catch(() => undefined));
            if (branchHandle === undefined) continue;
            const branchExec = branchHandle.accessor.get(IAgentExecutionService).status().state;
            const branchPrompts = branchHandle.accessor.get(IAgentPromptService);
            const branchQueue = branchPrompts.list();
            if (
              branchExec === 'starting' ||
              branchExec === 'running' ||
              branchExec === 'cancelling' ||
              branchQueue.active !== undefined ||
              branchQueue.launching !== undefined
            ) {
              continue;
            }
            const branchLostTasks = lostTasks.filter((task) => task.ownerAgentId === branchId);
            const branchHold = branchQueue.hold?.reason === 'recovery';
            if (branchHold) {
              branchPrompts.resumeRecoveredQueue();
            }
            if (branchHold && branchQueue.pending.length > 0) {
              promptId ??= branchQueue.pending[0]?.id;
              wokeAny = true;
            } else {
              const reminderBody = buildRecoveryReminderBody(branchId, targets, branchLostTasks);
              const handle = await branchPrompts.enqueue({
                message: {
                  id: randomUUID(),
                  role: 'user',
                  content: [{ type: 'text', text: `<system-reminder>\n${reminderBody}\n</system-reminder>` }],
                  toolCalls: [],
                  origin: { kind: 'system_trigger', name: 'interruption_recovery' },
                },
                waitForLaunch: false,
              });
              promptId ??= handle.id;
              wokeAny = true;
            }
          }
          if (!wokeAny) {
            reply.send(
              okEnvelope(
                {
                  session_id: sessionId,
                  agent_id: targetAgentId,
                  status: 'already_running' as const,
                  recovered_targets: [],
                },
                req.id,
              ),
            );
            return;
          }
        } else {
          if (hasRecoveryHold) {
            prompts.resumeRecoveredQueue();
          }
          if (hasRecoveryHold && queue.pending.length > 0) {
            promptId = queue.pending[0]?.id;
          } else {
            const reminderBody = buildRecoveryReminderBody(targetAgentId, targets, lostTasks);
            const handle = await prompts.enqueue({
              message: {
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text: `<system-reminder>\n${reminderBody}\n</system-reminder>` }],
                toolCalls: [],
                origin: { kind: 'system_trigger', name: 'interruption_recovery' },
              },
              waitForLaunch: false,
            });
            promptId = handle.id;
          }
        }

        const nextRecoveredAt = Date.now();
        const nextRecoveredLostTaskIds = mergeRecoveredLostTaskIds(meta.recoveredLostTaskIds, lostTasks);
        if (targetAgentId === MAIN_AGENT_ID) {
          await metadata.update(
            {
              interruptedWork: undefined,
              activeRunBootId: currentRuntimeBootId(),
              activeRunAgentIds: branchOnlyRecovery ? interruptedBranchIds : [MAIN_AGENT_ID],
              lastRecoveredAt: nextRecoveredAt,
              recoveredLostTaskIds: nextRecoveredLostTaskIds,
            },
            { touchUpdatedAt: false },
          );
        } else if (meta.interruptedWork !== undefined || lostTasks.length > 0) {
          const remaining = meta.interruptedWork?.targets?.filter((entry) => entry.agentId !== targetAgentId);
          const nextInterruptedWork =
            meta.interruptedWork === undefined
              ? undefined
              : remaining !== undefined && remaining.length > 0
                ? { ...meta.interruptedWork, targets: remaining }
                : meta.interruptedWork.mainInterrupted === true
                  ? { ...meta.interruptedWork, targets: undefined }
                  : undefined;
          await metadata.update(
            {
              interruptedWork: nextInterruptedWork,
              activeRunBootId: currentRuntimeBootId(),
              activeRunAgentIds: [targetAgentId],
              lastRecoveredAt: nextRecoveredAt,
              recoveredLostTaskIds: nextRecoveredLostTaskIds,
            },
            { touchUpdatedAt: false },
          );
        }
        core.accessor.get(IEventService).publish(
          new SessionMetaUpdated({
            payload: { agentId: targetAgentId, sessionId, patch: {} },
          }),
        );

        reply.send(
          okEnvelope(
            {
              session_id: sessionId,
              agent_id: targetAgentId,
              status: 'recovered' as const,
              prompt_id: promptId,
              recovered_targets: targets,
            },
            req.id,
          ),
        );
      });
    } catch (error) {
      reply.send(mapError(error, req.id));
    } finally {
      const set = activeRecoverBySession.get(sessionId);
      set?.delete(targetAgentId);
      if (set !== undefined && set.size === 0) activeRecoverBySession.delete(sessionId);
    }
  });
  app.post(recoverRoute.path, recoverRoute.options, recoverRoute.handler as Parameters<RecoverRouteHost['post']>[2]);
}
