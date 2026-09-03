import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, normalize, resolve } from 'node:path';

import type { PermissionMode, Scope } from '@moonshot-ai/agent-core-v2';
import { ulid } from 'ulid';
import { z } from 'zod';

import { readPrivateFile, writePrivateFile } from '../services/auth/privateFiles';
import { ensureExternalDelegationSeatSession } from './externalDelegationAuthority';

const seatSchema = z.object({
  seatId: z.string().min(1),
  sessionId: z.string().min(1),
  principal: z.string().min(1),
  delegationToken: z.string().min(1),
  workspace: z.string().min(1),
  mode: z.enum(['manual', 'auto', 'yolo']),
  model: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const documentSchema = z.object({
  version: z.literal(1),
  seats: z.array(seatSchema),
});

export interface ExternalDelegationSeat {
  readonly seatId: string;
  readonly sessionId: string;
  readonly principal: string;
  readonly delegationToken: string;
  readonly workspace: string;
  readonly mode: PermissionMode;
  readonly model?: string;
  readonly thinking?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ExternalDelegationSeatView {
  readonly seatId: string;
  readonly sessionId: string;
  readonly principal: string;
  readonly workspace: string;
  readonly mode: PermissionMode;
  readonly model?: string;
  readonly thinking?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class ExternalDelegationSeatManager {
  private readonly filePath: string;
  private mutation = Promise.resolve();

  constructor(
    private readonly core: Scope,
    homeDir: string,
    private readonly onWorkspaceServed: (workspace: string) => void | Promise<void>,
  ) {
    this.filePath = join(homeDir, 'server', 'external-delegation-seats.json');
  }

  create(input: {
    readonly workspace: string;
    readonly principal: string;
    readonly mode?: PermissionMode;
    readonly model?: string;
    readonly thinking?: string;
  }): Promise<ExternalDelegationSeat> {
    return this.serialize(async () => {
      const workspace = normalize(await realpath(resolve(input.workspace)));
      const document = await this.read();
      const existingIndex = document.seats.findIndex(
        (seat) => pathKey(seat.workspace) === pathKey(workspace) && seat.principal === input.principal,
      );
      const existing = existingIndex === -1 ? undefined : document.seats[existingIndex];
      const now = Date.now();
      const seat: ExternalDelegationSeat = existing ?? {
        seatId: `seat_${ulid()}`,
        sessionId: `session_seat_${ulid()}`,
        principal: input.principal,
        delegationToken: randomBytes(32).toString('base64url'),
        workspace,
        mode: input.mode ?? 'manual',
        model: input.model,
        thinking: input.thinking,
        createdAt: now,
        updatedAt: now,
      };
      const provisioned = await ensureExternalDelegationSeatSession(this.core, {
        sessionId: seat.sessionId,
        workspacePath: workspace,
        modelAlias: input.model ?? seat.model,
        thinkingEffort: input.thinking ?? seat.thinking,
        permissionMode: input.mode ?? seat.mode,
        title: input.principal,
      });
      const updated: ExternalDelegationSeat = {
        ...seat,
        workspace: provisioned.workspacePath,
        mode: provisioned.permissionMode,
        model: provisioned.modelAlias,
        thinking: provisioned.thinkingEffort,
        updatedAt: now,
      };
      if (existingIndex === -1) document.seats.push(updated);
      else document.seats[existingIndex] = updated;
      await this.write(document);
      await this.onWorkspaceServed(updated.workspace);
      return updated;
    });
  }

  async list(): Promise<readonly ExternalDelegationSeatView[]> {
    const document = await this.read();
    return document.seats.map(toView);
  }

  revoke(seatId: string): Promise<ExternalDelegationSeatView | undefined> {
    return this.serialize(async () => {
      const document = await this.read();
      const index = document.seats.findIndex((seat) => seat.seatId === seatId);
      if (index === -1) return undefined;
      const [seat] = document.seats.splice(index, 1);
      await this.write(document);
      return toView(seat!);
    });
  }

  async resolve(
    sessionId: string,
    token: string,
  ): Promise<{ readonly principalId: string; readonly sessionId: string } | undefined> {
    const document = await this.read();
    const seat = document.seats.find(
      (candidate) => candidate.sessionId === sessionId && tokenMatches(token, candidate.delegationToken),
    );
    return seat === undefined ? undefined : { principalId: seat.principal, sessionId: seat.sessionId };
  }

  private async read(): Promise<{ version: 1; seats: ExternalDelegationSeat[] }> {
    try {
      return documentSchema.parse(JSON.parse((await readPrivateFile(this.filePath)).toString('utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, seats: [] };
      throw error;
    }
  }

  private write(document: { version: 1; seats: ExternalDelegationSeat[] }): Promise<void> {
    return writePrivateFile(this.filePath, JSON.stringify(document));
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function toView(seat: ExternalDelegationSeat): ExternalDelegationSeatView {
  return {
    seatId: seat.seatId,
    sessionId: seat.sessionId,
    principal: seat.principal,
    workspace: seat.workspace,
    mode: seat.mode,
    model: seat.model,
    thinking: seat.thinking,
    createdAt: seat.createdAt,
    updatedAt: seat.updatedAt,
  };
}

function pathKey(value: string): string {
  const normalized = normalize(value);
  return platform() === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function tokenMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
