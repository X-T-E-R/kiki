import type { ToolCallFrame, TranscriptInteraction, TranscriptTurn } from '@kiki/transcript';

export interface PlanReviewInfo {
  state: 'pending' | 'approved' | 'rejected' | 'cancelled';
  selected_option?: string;
  feedback?: string;
}

export interface PlanInfo {
  tool_call_id: string;
  turn_id: string;
  source: 'interaction' | 'display' | 'output';
  plan: string;
  path?: string;
  options?: { label: string; description?: string }[];
  review?: PlanReviewInfo;
}

export interface ProjectedPlan {
  readonly info: PlanInfo;
  readonly frameId: string;
  readonly stepId: string;
}

interface PlanReviewDisplayInfo {
  plan: string;
  path?: string;
  options?: { label: string; description?: string }[];
}

export function projectTurnPlans(
  turn: TranscriptTurn,
  interactions: readonly TranscriptInteraction[],
  toolCallId?: string,
): ProjectedPlan[] {
  const plans: ProjectedPlan[] = [];
  for (const step of turn.steps) {
    for (const frame of step.frames) {
      if (frame.kind !== 'tool' || frame.name !== 'ExitPlanMode') continue;
      if (toolCallId !== undefined && frame.toolCallId !== toolCallId) continue;
      const info = projectPlanFrame(turn.turnId, frame, interactions);
      if (info !== undefined) plans.push({ info, frameId: frame.frameId, stepId: step.stepId });
    }
  }
  return plans;
}

export function projectPlanFrame(
  turnId: string,
  frame: ToolCallFrame,
  interactions: readonly TranscriptInteraction[],
): PlanInfo | undefined {
  const toolCallId = frame.toolCallId;
  const interaction = interactions.find(
    (candidate) => candidate.interactionKind === 'approval' && candidate.toolCallId === toolCallId,
  );
  const review = readPlanReview(interaction);
  const requestDisplay =
    interaction !== undefined && interaction.request !== null && typeof interaction.request === 'object'
      ? (interaction.request as { display?: unknown }).display
      : undefined;
  const fromInteraction = readPlanReviewDisplay(requestDisplay);
  if (fromInteraction !== undefined) {
    return { tool_call_id: toolCallId, turn_id: turnId, source: 'interaction', ...fromInteraction, review };
  }
  const fromDisplay = readPlanReviewDisplay(frame.display);
  if (fromDisplay !== undefined) {
    return { tool_call_id: toolCallId, turn_id: turnId, source: 'display', ...fromDisplay, review };
  }
  const fromOutput = parsePlanFromOutput(frame.output);
  if (fromOutput !== undefined) {
    return { tool_call_id: toolCallId, turn_id: turnId, source: 'output', ...fromOutput, review };
  }
  return undefined;
}

function readPlanReview(interaction: TranscriptInteraction | undefined): PlanReviewInfo | undefined {
  if (interaction === undefined) return undefined;
  const state = interaction.state;
  if (state !== 'pending' && state !== 'approved' && state !== 'rejected' && state !== 'cancelled') {
    return undefined;
  }
  const response =
    interaction.response !== null && typeof interaction.response === 'object'
      ? (interaction.response as { selectedLabel?: unknown; feedback?: unknown })
      : undefined;
  const selected =
    typeof response?.selectedLabel === 'string' && response.selectedLabel.length > 0
      ? response.selectedLabel
      : undefined;
  const feedback =
    typeof response?.feedback === 'string' && response.feedback.length > 0
      ? response.feedback
      : undefined;
  return { state, selected_option: selected, feedback };
}

function readPlanReviewDisplay(display: unknown): PlanReviewDisplayInfo | undefined {
  if (display === null || typeof display !== 'object') return undefined;
  const record = display as { kind?: unknown; plan?: unknown; path?: unknown; options?: unknown };
  if (record.kind !== 'plan_review' || typeof record.plan !== 'string' || record.plan.trim().length === 0) {
    return undefined;
  }
  const options = Array.isArray(record.options)
    ? record.options
        .map((option: unknown): { label: string; description?: string } | null => {
          if (option === null || typeof option !== 'object') return null;
          const entry = option as { label?: unknown; description?: unknown };
          if (typeof entry.label !== 'string' || entry.label.length === 0) return null;
          return {
            label: entry.label,
            description: typeof entry.description === 'string' ? entry.description : undefined,
          };
        })
        .filter((option): option is { label: string; description?: string } => option !== null)
    : undefined;
  return {
    plan: record.plan,
    path: typeof record.path === 'string' ? record.path : undefined,
    options: options !== undefined && options.length > 0 ? options : undefined,
  };
}

const PLAN_SAVED_TO_MARKER = 'Plan saved to: ';
const PLAN_BODY_MARKERS = ['## Approved Plan:\n', '## Plan (auto-approved, not user-reviewed):\n'];

function parsePlanFromOutput(output: unknown): { plan: string; path?: string } | undefined {
  if (typeof output !== 'string') return undefined;
  let path: string | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith(PLAN_SAVED_TO_MARKER)) {
      path = line.slice(PLAN_SAVED_TO_MARKER.length).trim() || undefined;
      break;
    }
  }
  for (const marker of PLAN_BODY_MARKERS) {
    const index = output.indexOf(marker);
    if (index === -1) continue;
    const plan = output.slice(index + marker.length);
    if (plan.trim().length > 0) return { plan, path };
  }
  return undefined;
}
