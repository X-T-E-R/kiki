import { z } from 'zod';

import { ErrorCodes, isError2, type Scope } from '@kiki/agent-core-v2';
import {
  IShippedAgentProfileManager,
  type ShippedAgentProfileStatusEntry,
} from '@kiki/agent-core-v2/app/shippedAgentProfiles/shippedAgentProfileManager';
import { IShippedAgentProfileSource } from '@kiki/agent-core-v2/app/shippedAgentProfiles/shippedAgentProfileSource';
import {
  listShippedAgentProfilesResponseSchema,
  shippedAgentProfileSchema,
  type ShippedAgentProfile,
} from '@kiki/protocol';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { parseActionSuffix } from './action-suffix';

interface ShippedAgentProfilesRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const actionParamsSchema = z.object({ tail: z.string().min(1) });

/** Registers the `/agents/shipped` routes — the management view over the shipped (built-in)
 *  agent profile templates: per-template on-disk status from the engine's shipped-profile
 *  manager, plus the restore-original action that resets a managed copy to the bundled
 *  original (the previous bytes are backed up by the manager first). */
export function registerShippedAgentProfilesRoute(app: ShippedAgentProfilesRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/agents/shipped',
      success: { data: listShippedAgentProfilesResponseSchema },
      description: 'List shipped agent profile templates with their on-disk management status',
      tags: ['agents'],
    },
    async (req, reply) => {
      const manager = core.accessor.get(IShippedAgentProfileManager);
      const source = core.accessor.get(IShippedAgentProfileSource);
      const entries = await manager.status();
      reply.send(
        okEnvelope({ items: entries.map((entry) => toWireShippedAgentProfile(entry, source)) }, req.id),
      );
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<ShippedAgentProfilesRouteHost['get']>[2]);

  const restoreRoute = defineRoute(
    {
      method: 'POST',
      path: '/agents/shipped/{tail}',
      params: actionParamsSchema,
      success: { data: shippedAgentProfileSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description: 'Reset a managed shipped agent profile copy to its bundled original',
      tags: ['agents'],
    },
    async (req, reply) => {
      const parsed = parseActionSuffix({
        tail: req.params.tail,
        allowedActions: ['restore'] as const,
        resourceLabel: 'shipped_agent_profile',
      });
      if (parsed.kind !== 'action') {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${req.params.tail}`,
            req.id,
          ),
        );
        return;
      }
      const manager = core.accessor.get(IShippedAgentProfileManager);
      try {
        const entry = await manager.restoreOriginal(parsed.id);
        reply.send(
          okEnvelope(
            toWireShippedAgentProfile(entry, core.accessor.get(IShippedAgentProfileSource)),
            req.id,
          ),
        );
      } catch (error) {
        if (isError2(error) && error.code === ErrorCodes.VALIDATION_FAILED) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
          return;
        }
        throw error;
      }
    },
  );
  app.post(restoreRoute.path, restoreRoute.options, restoreRoute.handler as Parameters<ShippedAgentProfilesRouteHost['post']>[2]);
}

function toWireShippedAgentProfile(
  entry: ShippedAgentProfileStatusEntry,
  source: IShippedAgentProfileSource,
): ShippedAgentProfile {
  const template = source.get(entry.templateId);
  return {
    template_id: entry.templateId,
    status: entry.status,
    managed: entry.managed,
    main: template?.main === true,
    description: template?.description,
    active_path: entry.activePath,
    baseline_hash: entry.baselineHash,
    active_hash: entry.activeHash,
    offered_hash: entry.offeredHash,
  };
}
