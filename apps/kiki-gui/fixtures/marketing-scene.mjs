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
  thinker: 'agent-thinker',
};

/**
 * Role → model binding: the story every promotional image tells. Judgement
 * roles (thinking, review/aesthetics) get the strongest models, mechanical and
 * exploration roles get fast ones. `rail` is the label the dispatch tree shows;
 * `id` is the catalog model id. main's rail label IS its catalog id so the
 * session model resolves (otherwise the composer shows the product's
 * "model is no longer available" banner — a real failure state).
 */
export const ROLE_BINDING = {
  main: { id: 'Kimi K3', rail: 'Kimi K3', display: 'Kimi K3', effort: 'max' },
  thinker: { id: 'axon/gpt-6-astra', rail: 'axon/gpt-6-astra', display: 'GPT-6 Astra', effort: 'xhigh' },
  reviewer: { id: 'claude-fable-5', rail: 'Claude Fable', display: 'Claude Fable', effort: 'high' },
  builder: { id: 'deepseek-v4-flash', rail: 'DeepSeek V4 Flash', display: 'DeepSeek V4 Flash', effort: 'max' },
  explorer: { id: 'glm-5.3-flash', rail: 'GLM 5.3 Flash', display: 'GLM 5.3 Flash', effort: 'max' },
};

export const MODEL = ROLE_BINDING.main.id;
export const MODEL_LABEL = ROLE_BINDING.main.display;

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
    thinking: { enabled: true, effort: ROLE_BINDING.main.effort },
  };
}

/**
 * Five bindings so every visible model label tells the same role story:
 * judgement on the strong models (Astra thinking, Fable review), execution and
 * exploration on the fast ones (DeepSeek, GLM).
 */
export function sampleModels() {
  const spec = (role, { provider, maxContextSize = 262_144, efforts, capabilities }) => ({
    provider,
    model: ROLE_BINDING[role].id,
    display_name: ROLE_BINDING[role].display,
    max_context_size: maxContextSize,
    support_efforts: efforts,
    default_effort: ROLE_BINDING[role].effort,
    capabilities,
  });
  return [
    spec('main', { provider: 'kimi-code', efforts: ['low', 'medium', 'high', 'max'], capabilities: ['reasoning', 'tools', 'vision'] }),
    spec('thinker', { provider: 'axon', efforts: ['high', 'xhigh', 'max'], capabilities: ['reasoning'] }),
    spec('reviewer', { provider: 'anthropic', maxContextSize: 200_000, efforts: ['low', 'medium', 'high', 'max'], capabilities: ['reasoning', 'vision'] }),
    spec('builder', { provider: 'deepseek', efforts: ['low', 'medium', 'max'], capabilities: ['tools'] }),
    spec('explorer', { provider: 'zhipu', maxContextSize: 131_072, efforts: ['low', 'max'], capabilities: ['tools'] }),
  ];
}

export function sampleProviders() {
  const provider = (id, type, model) => ({
    id,
    type,
    has_api_key: true,
    status: 'connected',
    default_model: model,
    models: [model],
  });
  return [
    provider('kimi-code', 'openai', ROLE_BINDING.main.id),
    provider('axon', 'openai', ROLE_BINDING.thinker.id),
    provider('anthropic', 'anthropic', ROLE_BINDING.reviewer.id),
    provider('deepseek', 'openai', ROLE_BINDING.builder.id),
    provider('zhipu', 'openai', ROLE_BINDING.explorer.id),
  ];
}

/** A running turn's meta block (agent phase `running`) for one role binding. */
export function runningMeta({ turnId = 2, step = 1, role = 'main' } = {}) {
  const binding = ROLE_BINDING[role];
  return {
    model: binding.rail,
    thinkingEffort: binding.effort,
    permission: 'manual',
    contextTokens: 41_200,
    maxContextTokens: 262_144,
    phase: { kind: 'running', turnId, step, stepId: `t${turnId}.${step}`, since: 0 },
  };
}

/** A finished turn's meta block (agent phase `ended`/`completed`). */
export function completedMeta({ turnId = 1, role = 'main' } = {}) {
  const binding = ROLE_BINDING[role];
  return {
    model: binding.rail,
    thinkingEffort: binding.effort,
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
