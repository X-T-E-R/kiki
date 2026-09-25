/**
 * marketing-scene — shared builders for the promotional screenshot scenarios.
 *
 * Every marketing shot renders the SAME fictional project (`sample-app`) so the
 * images read as one continuous workbench. Nothing here is product code: the
 * shapes are the real fixture-server wire shapes (see helpers.mjs +
 * fixture-transcript.mjs), only the content is written for the campaign.
 *
 * Locale/theme/viewport are chosen per shot by scripts/marketing-shots.mjs.
 * IDs and structure are identical across locales — only titles and body copy
 * differ, so the zh/en images are the same screen translated.
 */

import { sessionRecord, ts } from './helpers.mjs';

export const WORKSPACE_ID = 'wd_sample-app_000000000000';
export const SAMPLE_ROOT = 'C:/Projects/sample-app';

export const SESSION = {
  release: 'sess_sample_prepare_release',
  accessibility: 'sess_sample_review_accessibility',
  documentation: 'sess_sample_update_documentation',
};

/** Direct children of the release session (main + 3 subagents). */
export const AGENT = {
  explorer: 'agent-explorer',
  builder: 'agent-builder',
  reviewer: 'agent-reviewer',
};

/** One credible model binding so no surface falls back to "Unknown model". */
export const MODEL = 'kimi-code/k3';
export const MODEL_LABEL = 'Kimi K3';

export function sampleWorkspace() {
  return {
    id: WORKSPACE_ID,
    root: SAMPLE_ROOT,
    name: 'sample-app',
    created_at: ts(2880),
    last_opened_at: ts(2),
    session_count: 3,
    pinned: false,
  };
}

/**
 * The three sidebar sessions. `release` is the busy main session; the other
 * two are quiet so the sidebar reads as a real project, not a fixture list.
 */
export function sampleSessions() {
  return [
    sessionRecord(SESSION.release, {
      title: 'Prepare the release',
      workspace_id: WORKSPACE_ID,
      metadata: { cwd: SAMPLE_ROOT },
      busy: true,
      main_turn_active: true,
      pending_interaction: 'none',
      updated_at: ts(1),
      created_at: ts(180),
    }),
    sessionRecord(SESSION.accessibility, {
      title: 'Review accessibility',
      workspace_id: WORKSPACE_ID,
      metadata: { cwd: SAMPLE_ROOT },
      updated_at: ts(95),
      created_at: ts(240),
    }),
    sessionRecord(SESSION.documentation, {
      title: 'Update documentation',
      workspace_id: WORKSPACE_ID,
      metadata: { cwd: SAMPLE_ROOT },
      updated_at: ts(150),
      created_at: ts(400),
    }),
  ];
}

/** Config + model/provider catalog shared by every marketing scenario. */
export function sampleConfig() {
  return {
    default_provider: 'kimi-code',
    default_model: MODEL,
    default_permission_mode: 'manual',
    default_plan_mode: false,
    thinking: { enabled: true, effort: 'high' },
  };
}

export function sampleModels() {
  return [
    {
      provider: 'kimi-code',
      model: MODEL,
      display_name: MODEL_LABEL,
      max_context_size: 262144,
      support_efforts: ['low', 'medium', 'high'],
      default_effort: 'high',
      capabilities: ['reasoning', 'tools', 'vision'],
    },
  ];
}

export function sampleProviders() {
  return [
    {
      id: 'kimi-code',
      type: 'openai',
      has_api_key: true,
      status: 'connected',
      default_model: MODEL,
      models: [MODEL],
    },
  ];
}

/** A running turn's meta block (agent phase `running`). */
export function runningMeta({ turnId = 2, step = 1 } = {}) {
  return {
    model: MODEL,
    thinkingEffort: 'high',
    permission: 'manual',
    contextTokens: 41_200,
    maxContextTokens: 262_144,
    phase: { kind: 'running', turnId, step, stepId: `t${turnId}.${step}`, since: 0 },
  };
}

/** A finished turn's meta block (agent phase `ended`/`completed`). */
export function completedMeta({ turnId = 1 } = {}) {
  return {
    model: MODEL,
    thinkingEffort: 'high',
    contextTokens: 12_400,
    maxContextTokens: 262_144,
    phase: { kind: 'ended', turnId, reason: 'completed', at: 0 },
  };
}

/** One collapsed tool step inside the transcript's tool group. */
export function toolFrame({ frameId, toolCallId, name, input, output, state = 'done' }) {
  return { kind: 'tool', frameId, toolCallId, name, state, input, output };
}

export function textFrame({ frameId, text }) {
  return { kind: 'text', frameId, role: 'assistant', text };
}

/** A completed turn wrapping one step's frames. */
export function turn({ turnId, ordinal, prompt, frames, minutesAgo = 12, state = 'completed' }) {
  return {
    kind: 'turn',
    turnId,
    ordinal,
    state,
    origin: { kind: 'user' },
    prompt,
    startedAt: ts(minutesAgo),
    endedAt: state === 'completed' ? ts(minutesAgo - 1) : undefined,
    steps: [
      {
        kind: 'step',
        stepId: `${turnId}.1`,
        turnId,
        ordinal: 1,
        state: state === 'completed' ? 'completed' : 'running',
        startedAt: ts(minutesAgo),
        endedAt: state === 'completed' ? ts(minutesAgo - 1) : undefined,
        frames,
      },
    ],
  };
}
