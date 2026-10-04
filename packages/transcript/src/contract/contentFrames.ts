import type { TranscriptTurn } from '../model/turn';
import type { ContentRef } from './content';

export function rebindTurnContentRefs<T extends TranscriptTurn>(turn: T): T {
  const refs = turn.contentRefs;
  if (refs === undefined || refs.length === 0) return turn;
  const remaining: ContentRef[] = [];
  const frames = new Map<string, ContentRef[]>();
  for (const ref of refs) {
    const [steps, stepIndex, children, frameIndex] = ref.path;
    if (ref.source.kind !== 'turn' || ref.source.id !== turn.turnId || steps !== 'steps' || typeof stepIndex !== 'number' || children !== 'frames' || typeof frameIndex !== 'number' || ref.path.length <= 4) {
      remaining.push(ref);
      continue;
    }
    const step = turn.steps[stepIndex];
    const frame = step?.frames[frameIndex];
    if (step === undefined || frame === undefined) { remaining.push(ref); continue; }
    const key = `${stepIndex}/${frameIndex}`;
    const bound: ContentRef = {
      ...ref,
      source: { kind: 'frame', id: frame.frameId, turnId: turn.turnId, stepId: step.stepId },
      path: ref.path.slice(4),
    };
    const entries = frames.get(key) ?? [];
    entries.push(bound);
    frames.set(key, entries);
  }
  if (frames.size === 0) return turn;
  return {
    ...turn,
    contentRefs: remaining,
    steps: turn.steps.map((step, stepIndex) => ({
      ...step,
      frames: step.frames.map((frame, frameIndex) => {
        const entries = frames.get(`${stepIndex}/${frameIndex}`);
        return entries === undefined ? frame : { ...frame, contentRefs: [...(frame.contentRefs ?? []), ...entries] };
      }),
    })),
  };
}
