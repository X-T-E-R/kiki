import {
  Error2,
  ErrorCodes,
  IAgentProfileService,
  IAgentSkillService,
  IBootstrapService,
  IBuiltinSkillSource,
  IFileService,
  ISessionContext,
  ISessionIndex,
  ISessionMediaStore,
  ISessionManager,
  ISessionSkillCatalog,
  ITelemetryService,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  isError2,
  isUserActivatableSkillType,
  normalizeSkillName,
  resumeSessionById,
  sessionMediaOriginalsDir,
  type ContentPart,
  type ISessionScopeHandle,
  type Scope,
  type SkillDefinition,
} from '@kiki/agent-core-v2';
import { join } from 'node:path';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import {
  assertPromptFileRefs,
  contentToCoreParts,
  resolvePromptMediaFiles,
  resolvePromptSessionMediaRefs,
  type PromptMediaPreparation,
} from '../lib/promptMedia';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { ErrorCode } from '../protocol/error-codes';
import {
  activateSkillRequestSchema,
  activateSkillResultSchema,
  builtinSkillContentResponseSchema,
  listSkillsResponseSchema,
} from '../protocol/rest-skill';
import { workspaceIdParamSchema } from '../protocol/rest-workspace';
import type { SkillDescriptor } from '../protocol/skill';
import { parseActionSuffix } from './action-suffix';

interface SkillsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const skillTailParamsSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

type ResolvedSession =
  | { readonly handle: ISessionScopeHandle }
  | { readonly envelope: ReturnType<typeof errEnvelope> };

async function resolveActivatedSession(
  core: Scope,
  sessionId: string,
  requestId: string,
): Promise<ResolvedSession> {
  const handle = await resumeSessionById(core.accessor, sessionId);
  if (handle !== undefined) return { handle };

  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  const msg =
    summary === undefined
      ? `session ${sessionId} does not exist`
      : `session ${sessionId} is not activated, you need to activate it first`;
  return { envelope: errEnvelope(ErrorCode.SESSION_NOT_FOUND, msg, requestId) };
}

export function registerSkillsRoutes(app: SkillsRouteHost, core: Scope): void {
  const builtinContentRoute = defineRoute(
    {
      method: 'GET',
      path: '/skills/{tail}',
      params: z.object({ tail: z.string().min(1) }),
      success: { data: builtinSkillContentResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SKILL_NOT_FOUND]: {},
      },
      description: 'Read the content of a visible built-in skill',
      tags: ['skills'],
      operationId: 'readBuiltinSkillContent',
    },
    async (req, reply) => {
      const parsed = parseActionSuffix({
        tail: req.params.tail,
        allowedActions: ['content'] as const,
        resourceLabel: 'skill_name',
      });
      if (parsed.kind !== 'action') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${req.params.tail}`, req.id));
        return;
      }
      const { skills } = await core.accessor.get(IBuiltinSkillSource).load();
      const skill = skills.findLast((entry) => entry.source === 'builtin' && normalizeSkillName(entry.name) === normalizeSkillName(parsed.id));
      if (skill === undefined) {
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_FOUND, `Skill "${parsed.id}" was not found`, req.id));
        return;
      }
      reply.send(okEnvelope({ name: skill.name, content: skill.content }, req.id));
    },
  );
  app.get(
    builtinContentRoute.path,
    builtinContentRoute.options,
    builtinContentRoute.handler as Parameters<SkillsRouteHost['get']>[2],
  );

  const listSkillsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/skills',
      params: sessionIdParamSchema,
      success: { data: listSkillsResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List the skills available to a session',
      tags: ['skills'],
      operationId: 'listSkills',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const live = core.accessor.get(ISessionManager).get(session_id);
      if (live !== undefined) {
        const catalog = live.accessor.get(ISessionSkillCatalog);
        await catalog.ready;
        const skills = catalog.catalog.listSkills().map(toProtocolSkill);
        reply.send(okEnvelope({ skills }, req.id));
        return;
      }
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
        return;
      }
      if (await core.accessor.get(IWorkspaceService).get(summary.workspaceId) === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `workspace ${summary.workspaceId} for session ${session_id} does not exist`, req.id));
        return;
      }
      const lease = await core.accessor.get(IWorkspaceInstanceManager).acquire({ workspaceId: summary.workspaceId });
      try {
        await lease.instance.program.ready;
        const skills = lease.instance.program.skills.catalog.listSkills().map(toProtocolSkill);
        reply.send(okEnvelope({ skills }, req.id));
      } finally {
        lease.dispose();
      }
    },
  );
  app.get(
    listSkillsRoute.path,
    listSkillsRoute.options,
    listSkillsRoute.handler as Parameters<SkillsRouteHost['get']>[2],
  );

  const listWorkspaceSkillsRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces/{workspace_id}/skills',
      params: workspaceIdParamSchema,
      success: { data: listSkillsResponseSchema },
      errors: {
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'List the skills available to a workspace (no session required)',
      tags: ['skills'],
      operationId: 'listWorkspaceSkills',
    },
    async (req, reply) => {
      const { workspace_id } = req.params;
      const ws = await core.accessor.get(IWorkspaceService).get(workspace_id);
      if (ws === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }
      const skills = (await listWorkspaceSkillsForRoot(core, ws.id, ws.root)).map(toProtocolSkill);
      reply.send(okEnvelope({ skills }, req.id));
    },
  );
  app.get(
    listWorkspaceSkillsRoute.path,
    listWorkspaceSkillsRoute.options,
    listWorkspaceSkillsRoute.handler as Parameters<SkillsRouteHost['get']>[2],
  );

  const activateSkillRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/skills/{tail}',
      body: activateSkillRequestSchema,
      params: skillTailParamsSchema,
      success: { data: activateSkillResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SKILL_NOT_FOUND]: {},
        [ErrorCode.SKILL_NOT_ACTIVATABLE]: {},
        [ErrorCode.FILE_NOT_FOUND]: {},
      },
      description: 'Activate a skill in a session (REST analogue of the /<skill> slash command)',
      tags: ['skills'],
      operationId: 'activateSkill',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['activate'] as const,
        resourceLabel: 'skill_name',
      });
      if (parsed.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
        return;
      }
      if (parsed.kind === 'bare') {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }

      const resolved = await resolveActivatedSession(core, session_id, req.id);
      if ('envelope' in resolved) {
        reply.send(resolved.envelope);
        return;
      }

      let preparedMedia: PromptMediaPreparation | undefined;
      try {
        const attachments = req.body.attachments ?? [];
        const attachmentParts: ContentPart[] = [];
        const agent = await ensureMainAgent(resolved.handle);
        if (attachments.length > 0) {
          const catalog = resolved.handle.accessor.get(ISessionSkillCatalog);
          await catalog.ready;
          const skill = catalog.catalog.getSkill(parsed.id);
          if (skill === undefined) {
            throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${parsed.id}" was not found`);
          }
          if (!isUserActivatableSkillType(skill.metadata.type)) {
            throw new Error2(
              ErrorCodes.SKILL_TYPE_UNSUPPORTED,
              `Skill "${skill.name}" cannot be activated by the user`,
            );
          }
          await assertPromptFileRefs(attachments, core.accessor.get(IFileService));
          const submittedAttachments = await resolvePromptSessionMediaRefs(
            attachments,
            resolved.handle.accessor.get(ISessionMediaStore),
          );
          const telemetry = core.accessor.get(ITelemetryService).withContext({ sessionId: session_id });
          const sessionDir = resolved.handle.accessor.get(ISessionContext).sessionDir;
          preparedMedia = await resolvePromptMediaFiles(
            submittedAttachments,
            core.accessor.get(IFileService),
            core.accessor.get(IBootstrapService).cacheDir,
            {
              telemetry,
              providerType: agent.accessor
                .get(IAgentProfileService)
                .getModelProviderType(),
              resolveOriginalsDir: async () => sessionMediaOriginalsDir(sessionDir),
              resolveAttachmentsDir: async () => join(sessionDir, 'attachments'),
            },
          );
          attachmentParts.push(...contentToCoreParts(preparedMedia.content));
        }
        await agent.accessor
          .get(IAgentSkillService)
          .activate({ name: parsed.id, args: req.body.args, content: attachmentParts });
        await preparedMedia?.discard();
        preparedMedia = undefined;
        requestLog(req)?.info({ session_id, skill_name: parsed.id }, 'skill activated');
        reply.send(okEnvelope({ activated: true, skill_name: parsed.id }, req.id));
      } catch (err) {
        await preparedMedia?.discard();
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    activateSkillRoute.path,
    activateSkillRoute.options,
    activateSkillRoute.handler as Parameters<SkillsRouteHost['post']>[2],
  );
}

async function listWorkspaceSkillsForRoot(
  core: Scope,
  workspaceId: string,
  workDir: string,
): Promise<readonly SkillDefinition[]> {
  const lease = await core.accessor
    .get(IWorkspaceInstanceManager)
    .acquire({ workspaceId, root: workDir });
  try {
    await lease.instance.program.ready;
    return lease.instance.program.skills.catalog.listSkills();
  } finally {
    lease.dispose();
  }
}

type SkillElement = ReturnType<ISessionSkillCatalog['catalog']['listSkills']>[number];

function toProtocolSkill(skill: SkillElement): SkillDescriptor {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    source: skill.source,
    type: skill.metadata.type,
    disable_model_invocation: skill.metadata.disableModelInvocation,
    prompt_command: skill.metadata.promptCommand,
    argument_hint: skill.metadata.argumentHint,
  };
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.SKILL_NOT_FOUND:
      case ErrorCodes.SKILL_NAME_EMPTY:
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.SKILL_TYPE_UNSUPPORTED:
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_ACTIVATABLE, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FILE_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.FILE_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.VALIDATION_FAILED:
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
    }
  }
  throw err;
}
