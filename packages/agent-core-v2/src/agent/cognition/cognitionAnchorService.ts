/**
 * `cognition` domain — `IAgentCognitionAnchorService` implementation.
 *
 * Request-time projection of `[models.<alias>.cognition].anchor` onto
 * turn LLM requests. The file is loaded once and cached. Whether a
 * request is anchored is a function of `source.step`, `anchorSteps`,
 * `anchorScope`, and the turn id. Bound at Agent scope.
 */

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { CognitionConfig } from '#/kosong/model/model';
import { IModelService } from '#/kosong/model/model';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import {
  IAgentCognitionAnchorService,
  type CognitionAnchorProjectionInput,
} from './cognitionAnchor';
import { cognitionPathRefs, readCognitionSlot } from './cognitionFiles';

const DEFAULT_ANCHOR_STEPS = 1;
const DEFAULT_ANCHOR_SCOPE = 'session';

// The loop reserves turn ids from a wire-persisted clock that starts at zero
// (`agent/loop/turnOps.ts`), so this identifies the agent's opening turn even
// after a cold resume, where an in-memory latch would re-anchor mid-session.
const FIRST_TURN_ID = 0;

export class AgentCognitionAnchorService implements IAgentCognitionAnchorService {
  declare readonly _serviceBrand: undefined;

  private cachedText: string | undefined;
  private hasCachedText = false;
  private inflight: Promise<string | undefined> | undefined;

  constructor(
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelService private readonly models: IModelService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
  ) {}

  async project(input: CognitionAnchorProjectionInput): Promise<string | undefined> {
    if (input.sourceType !== 'turn' || input.turnId === undefined) return undefined;
    const cognition = this.cognition();
    const refs = cognitionPathRefs(cognition?.anchor);
    if (refs.length === 0) return undefined;

    if (input.hasExplicitSystemPrompt) return undefined;
    if (!stepWithinAnchorWindow(input.step, cognition?.anchorSteps ?? DEFAULT_ANCHOR_STEPS)) {
      return undefined;
    }
    if (
      (cognition?.anchorScope ?? DEFAULT_ANCHOR_SCOPE) !== 'turn' &&
      input.turnId !== FIRST_TURN_ID
    ) {
      return undefined;
    }
    return this.loadAnchor(refs);
  }

  private cognition(): CognitionConfig | undefined {
    const alias = this.profile.data().modelAlias;
    if (alias === undefined || alias.length === 0) return undefined;
    return this.models.get(alias)?.cognition;
  }

  private async loadAnchor(refs: readonly string[]): Promise<string | undefined> {
    if (this.hasCachedText) return this.cachedText;
    if (this.inflight !== undefined) return this.inflight;
    this.inflight = readCognitionSlot(
      this.fs,
      this.bootstrap.homeDir,
      'anchor',
      refs,
      this.hostEnv.pathClass,
    ).then(
      (text) => {
        this.cachedText = text;
        this.hasCachedText = true;
        this.inflight = undefined;
        return text;
      },
      (error: unknown) => {
        this.inflight = undefined;
        throw error;
      },
    );
    return this.inflight;
  }
}

function stepWithinAnchorWindow(step: number | undefined, anchorSteps: number): boolean {
  return step !== undefined && step >= 1 && step <= anchorSteps;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCognitionAnchorService,
  AgentCognitionAnchorService,
  ScopeActivation.OnScopeCreated,
  'cognition',
);
