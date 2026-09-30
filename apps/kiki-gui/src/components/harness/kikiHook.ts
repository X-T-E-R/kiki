/** A timeline hook result Kiki injected into an external engine: `kiki:<harness>:<event>`. */
export interface KikiHookEvent {
  readonly harness: string;
  readonly event: string;
  /** PreCompact readies the compaction handoff; nothing reaches the engine. */
  readonly prepared: boolean;
}

export function parseKikiHookEvent(event: string | undefined): KikiHookEvent | undefined {
  const match = event === undefined ? null : /^kiki:([a-z0-9-]+):([A-Za-z]+)$/.exec(event);
  if (match === null) return undefined;
  return { harness: match[1]!, event: match[2]!, prepared: match[2] === 'PreCompact' };
}

const PREPARED_PREFIX = /^\[Handoff prepared; not injected by this hook\]\n?/;

/** One `[Kiki <origin>]` part of an injection, so the body reads as labelled sections. */
export interface KikiHookPart {
  readonly origin: string;
  readonly text: string;
}

export function kikiHookParts(text: string): KikiHookPart[] {
  const body = text.replace(PREPARED_PREFIX, '');
  const parts: KikiHookPart[] = [];
  const pattern = /^\[Kiki ([^\]\n]+)\]\n/gm;
  const heads = [...body.matchAll(pattern)];
  if (heads.length === 0) return body.trim() === '' ? [] : [{ origin: '', text: body.trim() }];
  const lead = body.slice(0, heads[0]!.index).trim();
  if (lead !== '') parts.push({ origin: '', text: lead });
  heads.forEach((head, index) => {
    const start = head.index! + head[0].length;
    const end = index + 1 < heads.length ? heads[index + 1]!.index! : body.length;
    parts.push({ origin: head[1]!, text: body.slice(start, end).trim() });
  });
  return parts;
}
