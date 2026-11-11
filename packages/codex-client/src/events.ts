import type { NormalizedExecutorEvent } from '@kiki/protocol';

import { CodexClientError } from '#/errors';
import type {
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexTurnOutcome,
  CodexUsageLimitOutcome,
} from '#/types';

export interface CodexMcpToolResultImage {
  readonly data: string;
  readonly mimeType: string;
  readonly uri?: string;
}

export interface CodexFileChangeEntry {
  readonly path: string;
  readonly kind?: string;
  readonly diff?: string;
  readonly movePath?: string;
}

export interface CodexStructuredFileDiff {
  readonly type: 'diff';
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
  readonly movePath?: string;
}

export interface CodexMappedNotification {
  readonly events: readonly NormalizedExecutorEvent[];
  readonly completion?: {
    readonly threadId: string;
    readonly turnId: string;
    readonly status: string;
    readonly error?: unknown;
    readonly outcome: CodexTurnOutcome;
  };
  readonly usage?: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly contextWindow?: number;
  };
  readonly cumulativeUsage?: CodexMappedNotification['usage'];
  readonly terminalError?: unknown;
  readonly rateLimits?: CodexRateLimitSnapshot;
}

export const CODEX_TOOL_CALL_DIFF_MAX_CHARS = 12_000;

/** Codex refused an MCP call that needs approval because the thread's approval policy is `never`. */
export const CODEX_MCP_APPROVAL_DENIED = 'codex_mcp_approval_denied';

const CODEX_SHELL_ENVELOPE_HEADER_LINES = [
  'chunk id:',
  'wall time:',
  'process exited with code',
  'original token count:',
] as const;

const CODEX_MANAGED_ERRORS: Readonly<Record<string, { readonly message: string; readonly usageLimit: boolean }>> = {
  subscription_sharing_v2_user_not_eligible: {
    message: 'ChatGPT sharing is unavailable for this account or workspace. Use another provider or check its sharing policy.',
    usageLimit: false,
  },
  subscription_sharing_user_not_eligible: {
    message: 'ChatGPT sharing is unavailable for this account or workspace. Use another provider or check its sharing policy.',
    usageLimit: false,
  },
  subscription_sharing_usage_limit_exceeded: {
    message: 'Your ChatGPT usage limit was reached. Check ChatGPT Usage settings for your available allowance.',
    usageLimit: true,
  },
  subscription_sharing_workplace_individual_usage_limit_exceeded: {
    message: "You reached your workspace's limit for using ChatGPT in other apps. Ask your workspace admin to increase it.",
    usageLimit: true,
  },
  subscription_sharing_usage_unavailable: {
    message: 'ChatGPT usage is temporarily unavailable. Try again shortly.',
    usageLimit: false,
  },
  subscription_sharing_unsupported_capability: {
    message: 'Codex used a feature that ChatGPT sharing does not support. Use another provider for this request.',
    usageLimit: false,
  },
  subscription_sharing_v2_client_not_enabled: {
    message: 'This app is not enabled for this ChatGPT connection. Use your existing CLI or another provider.',
    usageLimit: false,
  },
  subscription_sharing_v2_route_not_supported: {
    message: 'ChatGPT does not support this request route.',
    usageLimit: false,
  },
  subscription_sharing_route_not_supported: {
    message: 'ChatGPT does not support this request route.',
    usageLimit: false,
  },
  subscription_sharing_v2_invalid_user: {
    message: 'ChatGPT could not validate this connection. Check the selected account and sharing permissions.',
    usageLimit: false,
  },
  subscription_sharing_invalid_user: {
    message: 'ChatGPT could not validate this connection. Check the selected account and sharing permissions.',
    usageLimit: false,
  },
  subscription_sharing_v2_user_unavailable: {
    message: 'ChatGPT is temporarily unavailable. Try again shortly.',
    usageLimit: false,
  },
  subscription_sharing_user_unavailable: {
    message: 'ChatGPT is temporarily unavailable. Try again shortly.',
    usageLimit: false,
  },
  chatpass_v2_scope_not_authorized: {
    message: "This ChatGPT grant does not authorize the request. Check the connection's sharing permissions.",
    usageLimit: false,
  },
  chatpass_v2_invalid_authorization_context: {
    message: 'ChatGPT could not authorize this connection. Check the client and sharing permissions.',
    usageLimit: false,
  },
};

export function mapCodexNotification(
  method: string,
  input: unknown,
): CodexMappedNotification {
  const params = record(input, `${method}.params`);
  if (method === 'item/agentMessage/delta') {
    return { events: [textDelta('message.delta', params, 'assistant')] };
  }
  if (
    method === 'item/reasoning/textDelta' ||
    method === 'item/reasoning/summaryTextDelta'
  ) {
    return { events: [textDelta('thought.delta', params)] };
  }
  if (method === 'item/started') {
    const item = record(params['item'], 'item/started.item');
    return { events: startedEvents(item) };
  }
  if (method === 'item/completed') {
    const item = record(params['item'], 'item/completed.item');
    return { events: completedEvents(item) };
  }
  if (method === 'item/commandExecution/outputDelta') {
    return {
      events: [{
        type: 'tool.update',
        toolCallId: requiredString(params['itemId'], `${method}.itemId`),
        status: 'in_progress',
        content: [{ type: 'text', text: requiredString(params['delta'], `${method}.delta`) }],
      }],
    };
  }
  if (method === 'item/fileChange/patchUpdated') {
    const projected = projectFileChangePayload(params['changes']);
    return {
      events: [{
        type: 'tool.update',
        toolCallId: requiredString(params['itemId'], `${method}.itemId`),
        title: projected.files.length > 0 ? projected.title : undefined,
        kind: 'file',
        status: 'in_progress',
        rawOutput: projected.rawOutput,
        content: projected.diffs.length > 0 ? projected.diffs : undefined,
        locations: projected.locations,
      }],
    };
  }
  if (method === 'turn/diff/updated') {
    return { events: [{ type: 'turn.diff', diff: requiredString(params['diff'], `${method}.diff`) }] };
  }
  if (method === 'thread/compacted') {
    return { events: [{ type: 'context.compacted', threadId: requiredString(params['threadId'], `${method}.threadId`) }] };
  }
  if (method === 'turn/plan/updated') {
    return {
      events: [{
        type: 'plan.update',
        plan: { explanation: params['explanation'], steps: params['plan'] },
        unstable: false,
      }],
    };
  }
  if (method === 'thread/tokenUsage/updated') {
    const tokenUsage = record(params['tokenUsage'], `${method}.tokenUsage`);
    const last = record(tokenUsage['last'], `${method}.tokenUsage.last`);
    const total = record(tokenUsage['total'], `${method}.tokenUsage.total`);
    const inputTokens = finite(last['inputTokens'], `${method}.inputTokens`);
    const cachedInputTokens = finite(last['cachedInputTokens'], `${method}.cachedInputTokens`);
    const outputTokens = finite(last['outputTokens'], `${method}.outputTokens`);
    const contextWindow = optionalFinite(tokenUsage['modelContextWindow']);
    return {
      events: [{
        type: 'usage',
        used: finite(last['totalTokens'], `${method}.totalTokens`),
        size: contextWindow ?? 0,
      }],
      usage: { inputTokens, cachedInputTokens, outputTokens, contextWindow },
      cumulativeUsage: {
        inputTokens: finite(total['inputTokens'], `${method}.total.inputTokens`),
        cachedInputTokens: finite(total['cachedInputTokens'], `${method}.total.cachedInputTokens`),
        outputTokens: finite(total['outputTokens'], `${method}.total.outputTokens`),
        contextWindow,
      },
    };
  }
  if (method === 'account/rateLimits/updated') {
    const rateLimits = parseCodexRateLimitSnapshot(
      objectOptional(params['rateLimitsByLimitId'])?.['codex'] ?? params['rateLimits'] ?? params,
    );
    const resetAt = codexUsageLimitResetAt(rateLimits) ?? undefined;
    return {
      events: [{
        type: 'session.info',
        meta: {
          source: 'codex-app-server',
          updateType: method,
          rateLimits,
          resetAt,
        },
      }],
      rateLimits,
    };
  }
  if (method === 'turn/started') {
    const turn = record(params['turn'], `${method}.turn`);
    return {
      events: [{
        type: 'session.info',
        meta: {
          source: 'codex-app-server',
          updateType: method,
          status: 'running',
          turnId: optionalString(turn['id']),
        },
      }],
    };
  }
  if (method === 'thread/status/changed') {
    return {
      events: [{
        type: 'session.info',
        meta: {
          source: 'codex-app-server',
          updateType: method,
          status: optionalString(params['status']) ?? optionalString(objectOptional(params['status'])?.['type']),
        },
      }],
    };
  }
  if (method === 'error') {
    const error = record(params['error'], `${method}.error`);
    const outcome = parseCodexTurnOutcome('failed', error);
    return {
      events: [{
        type: 'session.info',
        meta: {
          source: 'codex-app-server',
          updateType: method,
          error: optionalString(error['message']) ?? optionalString(params['message']),
          willRetry: params['willRetry'] === true,
          errorCode: outcome.errorCode,
          usageLimit: outcome.usageLimit,
        },
      }],
      terminalError: params['willRetry'] === true ? undefined : error,
    };
  }
  if (method === 'turn/completed') {
    const threadId = requiredString(params['threadId'], `${method}.threadId`);
    const turn = record(params['turn'], `${method}.turn`);
    const status = requiredString(turn['status'], `${method}.turn.status`);
    const error = turn['error'];
    const outcome = parseCodexTurnOutcome(status, error);
    return {
      events: [],
      completion: {
        threadId,
        turnId: requiredString(turn['id'], `${method}.turn.id`),
        status,
        error,
        outcome,
      },
    };
  }
  return {
    events: [{ type: 'unknown', updateType: method }],
  };
}

export function normalizeCommandExecutionCommand(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = unwrapShellCommand(value);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (parts.length === 0) return undefined;
  if (parts.length >= 3 && (parts[1] === '-lc' || parts[1] === '-c')) {
    const unwrapped = parts[2]?.trim();
    return unwrapped && unwrapped.length > 0 ? unwrapped : undefined;
  }
  if (
    parts.length >= 3 &&
    isWindowsShellCommand(parts[0] ?? '') &&
    /^(-command|-c|\/c)$/i.test(parts[1] ?? '')
  ) {
    const unwrapped = parts.slice(2).join(' ').trim();
    return unwrapped.length > 0 ? stripMatchingEdgeQuotes(unwrapped) : undefined;
  }
  return parts.join(' ');
}

export function extractCodexShellOutput(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const normalized = value.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  if (!looksLikeCodexShellEnvelope(lines)) return value;
  const outputLineIndex = lines.findIndex((line) => line.trim() === 'Output:');
  if (outputLineIndex >= 0) {
    const body = lines.slice(outputLineIndex + 1).join('\n');
    return body.length > 0 ? body : undefined;
  }
  let firstBodyLineIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (!isCodexShellEnvelopeHeaderLine(lines[index] ?? '')) {
      firstBodyLineIndex = index;
      break;
    }
  }
  if (firstBodyLineIndex < 0) return undefined;
  const body = lines.slice(firstBodyLineIndex).join('\n');
  return body.length > 0 ? body : undefined;
}

export function splitCodexMcpToolResultImages(result: unknown): {
  readonly images: readonly CodexMcpToolResultImage[];
  readonly output: unknown;
} {
  const rec = objectOptional(result);
  if (rec === undefined || !Array.isArray(rec['content'])) {
    return { images: [], output: result };
  }
  const images: CodexMcpToolResultImage[] = [];
  const content = rec['content'].map((block) => {
    const blockRec = objectOptional(block);
    if (
      blockRec?.['type'] !== 'image' ||
      typeof blockRec['data'] !== 'string' ||
      typeof blockRec['mimeType'] !== 'string'
    ) {
      return block;
    }
    images.push({
      data: blockRec['data'],
      mimeType: blockRec['mimeType'],
      uri: optionalString(blockRec['uri']),
    });
    return { type: 'text', text: '[image]' };
  });
  if (images.length === 0) return { images, output: result };
  return {
    images,
    output: { ...rec, content },
  };
}

export function codexApplyPatchToUnifiedDiff(text: string): string {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const output: string[] = [];
  let sawDiffContent = false;
  for (const line of lines) {
    const directive = parseCodexApplyPatchDirective(line);
    if (directive !== undefined) {
      const path = normalizeDiffHeaderPath(directive.path);
      if (path.length > 0) {
        if (output.length > 0 && output.at(-1) !== '') output.push('');
        const left = directive.kind === 'add' ? '/dev/null' : `a/${path}`;
        const right = directive.kind === 'delete' ? '/dev/null' : `b/${path}`;
        output.push(`diff --git a/${path} b/${path}`);
        output.push(`--- ${left}`);
        output.push(`+++ ${right}`);
        sawDiffContent = true;
      }
      continue;
    }
    const trimmed = line.trim();
    if (
      trimmed === '*** Begin Patch' ||
      trimmed === '*** End Patch' ||
      trimmed === '*** End of File'
    ) {
      continue;
    }
    if (trimmed.startsWith('*** Move to:')) {
      const moveTarget = normalizeDiffHeaderPath(trimmed.slice('*** Move to:'.length));
      if (moveTarget.length > 0 && output.length >= 3) {
        const lastPlus = output.at(-1);
        if (lastPlus?.startsWith('+++ b/')) {
          output[output.length - 1] = `+++ b/${moveTarget}`;
        }
      }
      continue;
    }
    if (
      line.startsWith('@@') ||
      line.startsWith('+') ||
      line.startsWith('-') ||
      line.startsWith(' ') ||
      line.startsWith('\\ No newline at end of file')
    ) {
      output.push(line);
      sawDiffContent = true;
    }
  }
  if (!sawDiffContent) return text;
  const normalized = output.join('\n').trim();
  return normalized.length > 0 ? normalized : text;
}

export function parseCodexApplyPatchEntries(patchText: string): CodexFileChangeEntry[] {
  const lines = patchText.replaceAll('\r\n', '\n').split('\n');
  const entries: CodexFileChangeEntry[] = [];
  let current: {
    path: string;
    kind: 'add' | 'update' | 'delete';
    movePath?: string;
    body: string[];
  } | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    const rawPatch = [
      current.kind === 'add'
        ? `*** Add File: ${current.path}`
        : current.kind === 'delete'
          ? `*** Delete File: ${current.path}`
          : `*** Update File: ${current.path}`,
      ...(current.movePath === undefined ? [] : [`*** Move to: ${current.movePath}`]),
      ...current.body,
    ].join('\n');
    entries.push({
      path: current.path,
      kind: current.kind,
      movePath: current.movePath,
      diff: codexApplyPatchToUnifiedDiff(rawPatch),
    });
    current = undefined;
  };

  for (const line of lines) {
    const directive = parseCodexApplyPatchDirective(line);
    if (directive !== undefined) {
      flush();
      const path = normalizeDiffHeaderPath(directive.path);
      if (path.length > 0) current = { path, kind: directive.kind, body: [] };
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '*** Begin Patch' || trimmed === '*** End Patch') {
      if (trimmed === '*** End Patch') flush();
      continue;
    }
    if (current === undefined) continue;
    if (trimmed.startsWith('*** Move to:')) {
      const target = normalizeDiffHeaderPath(trimmed.slice('*** Move to:'.length));
      if (target.length > 0) current.movePath = target;
      continue;
    }
    if (trimmed === '*** End of File') continue;
    current.body.push(line);
  }
  flush();
  return entries;
}

export function parseCodexFileChanges(changes: unknown): CodexFileChangeEntry[] {
  if (changes === undefined || changes === null) return [];
  if (typeof changes === 'string') {
    if (looksLikeCodexApplyPatch(changes)) return parseCodexApplyPatchEntries(changes);
    if (looksLikeUnifiedDiff(changes)) return parseUnifiedDiffEntries(changes);
    return [];
  }
  if (Array.isArray(changes)) {
    return changes
      .map((entry) => {
        const rec = objectOptional(entry);
        return rec === undefined ? undefined : toFileChangeEntry(rec);
      })
      .filter((entry): entry is CodexFileChangeEntry => entry !== undefined);
  }
  const rec = objectOptional(changes);
  if (rec === undefined) return [];
  if (Array.isArray(rec['files'])) return parseCodexFileChanges(rec['files']);
  if (Array.isArray(rec['changes'])) return parseCodexFileChanges(rec['changes']);
  const patchString = pickFirstNonEmptyString([
    rec['patch'],
    rec['patchText'],
    rec['diff'],
    rec['unified_diff'],
    rec['unifiedDiff'],
  ]);
  const directPath = parseFileChangePath(rec);
  if (patchString !== undefined && directPath === undefined) {
    const parsedPatch = parseCodexFileChanges(patchString);
    if (parsedPatch.length > 0) return parsedPatch;
  }
  const single = toFileChangeEntry(rec);
  if (single !== undefined) return [single];
  return Object.entries(rec)
    .map(([path, value]) => {
      const valueRec = objectOptional(value);
      if (valueRec !== undefined) return toFileChangeEntry(valueRec, path);
      if (typeof value === 'string') {
        const trimmedPath = path.trim();
        return trimmedPath.length > 0 ? { path: trimmedPath, diff: value } : undefined;
      }
      return undefined;
    })
    .filter((entry): entry is CodexFileChangeEntry => entry !== undefined);
}

export function fileChangesToPreview(
  files: readonly CodexFileChangeEntry[],
  maxChars = CODEX_TOOL_CALL_DIFF_MAX_CHARS,
): {
  readonly filePath: string | undefined;
  readonly unifiedDiff: string;
} {
  const diffs = files
    .map((file) => ({ filePath: file.path, diff: fileChangeToUnifiedDiff(file) }))
    .filter((file) => file.diff.length > 0);
  const filePath = diffs[0]?.filePath ?? files[0]?.path;
  const combined = diffs.map((file) => file.diff).join('\n\n');
  if (combined.length <= maxChars) return { filePath, unifiedDiff: combined };

  const marker = '\n...[truncated]';
  const omittedNotice = (count: number) => count > 0 ? `\n\n...[${count} more files omitted]` : '';
  const previews = diffs.map((file) => splitFileDiffPreview(file.diff));
  const visible: typeof previews = [];
  let minimumSize = 0;
  for (const preview of previews) {
    const required = preview.header.length + Math.max(marker.length, Math.min(80, preview.body.length));
    const nextSize = minimumSize + required + (visible.length > 0 ? 2 : 0);
    if (nextSize + omittedNotice(previews.length - visible.length - 1).length > maxChars) break;
    visible.push(preview);
    minimumSize = nextSize;
  }
  if (visible.length === 0 && previews[0] !== undefined) {
    return {
      filePath,
      unifiedDiff: truncateDiffText(previews[0].header + previews[0].body, maxChars),
    };
  }
  const omitted = omittedNotice(previews.length - visible.length);
  const headersSize = visible.reduce((size, preview) => size + preview.header.length, 0);
  const bodyBudget = Math.max(
    marker.length,
    Math.floor(
      (maxChars - headersSize - Math.max(0, visible.length - 1) * 2 - omitted.length) /
        Math.max(1, visible.length),
    ),
  );
  const unifiedDiff = visible
    .map(({ header, body }) =>
      header + (body.length <= bodyBudget ? body : body.slice(0, Math.max(0, bodyBudget - marker.length)) + marker),
    )
    .join('\n\n') + omitted;
  return { filePath, unifiedDiff };
}

export function extractStructuredFileDiffs(
  files: readonly CodexFileChangeEntry[],
): CodexStructuredFileDiff[] {
  const results: CodexStructuredFileDiff[] = [];
  for (const file of files) {
    const isMoveOnly = Boolean(file.movePath && (!file.diff || file.diff.startsWith('\n\nMoved to: ')));
    if (isMoveOnly) continue;
    const rawDiff = file.diff;
    if (file.kind === 'add' && rawDiff !== undefined) {
      if (looksLikeUnifiedDiff(rawDiff) || looksLikeCodexApplyPatch(rawDiff)) {
        const unified = looksLikeCodexApplyPatch(rawDiff) ? codexApplyPatchToUnifiedDiff(rawDiff) : rawDiff;
        const extracted = oldAndNewFromUnifiedDiff(unified);
        results.push({
          type: 'diff',
          path: file.movePath ?? file.path,
          oldText: null,
          newText: extracted.after,
          movePath: file.movePath,
        });
      } else {
        results.push({
          type: 'diff',
          path: file.movePath ?? file.path,
          oldText: null,
          newText: rawDiff,
          movePath: file.movePath,
        });
      }
      continue;
    }
    if (file.kind === 'delete') {
      if (rawDiff !== undefined && (looksLikeUnifiedDiff(rawDiff) || looksLikeCodexApplyPatch(rawDiff))) {
        const unified = looksLikeCodexApplyPatch(rawDiff) ? codexApplyPatchToUnifiedDiff(rawDiff) : rawDiff;
        const extracted = oldAndNewFromUnifiedDiff(unified);
        results.push({
          type: 'diff',
          path: file.path,
          oldText: extracted.before,
          newText: '',
        });
      } else if (rawDiff !== undefined) {
        results.push({
          type: 'diff',
          path: file.path,
          oldText: rawDiff,
          newText: '',
        });
      }
      continue;
    }
    if (rawDiff === undefined || rawDiff.length === 0) continue;
    if (looksLikeUnifiedDiff(rawDiff) || looksLikeCodexApplyPatch(rawDiff)) {
      const unified = looksLikeCodexApplyPatch(rawDiff) ? codexApplyPatchToUnifiedDiff(rawDiff) : rawDiff;
      const extracted = oldAndNewFromUnifiedDiff(unified);
      if (extracted.sawHunk) {
        results.push({
          type: 'diff',
          path: file.movePath ?? file.path,
          oldText: extracted.isAdd ? null : extracted.before,
          newText: extracted.after,
          movePath: file.movePath,
        });
      }
      continue;
    }
    results.push({
      type: 'diff',
      path: file.movePath ?? file.path,
      oldText: null,
      newText: rawDiff,
      movePath: file.movePath,
    });
  }
  return results;
}

export function parseCodexRateLimitSnapshot(value: unknown): CodexRateLimitSnapshot | undefined {
  const rec = objectOptional(value);
  if (rec === undefined) return undefined;
  const primary = parseRateLimitWindow(rec['primary']);
  const secondary = parseRateLimitWindow(rec['secondary']);
  const individualRec = objectOptional(rec['individualLimit'] ?? rec['individual_limit']);
  const remainingPercent = optionalFinite(individualRec?.['remainingPercent'] ?? individualRec?.['remaining_percent']);
  const indResetsAt = parseEpochSeconds(individualRec?.['resetsAt'] ?? individualRec?.['resets_at']);
  const individualLimit = remainingPercent !== undefined && indResetsAt !== undefined
    ? { remainingPercent, resetsAt: indResetsAt }
    : rec['individualLimit'] === null || rec['individual_limit'] === null ? null : undefined;
  const limitId = rec['limitId'] === null ? null : optionalString(rec['limitId'] ?? rec['limit_id']);
  const planType = rec['planType'] === null ? null : optionalString(rec['planType'] ?? rec['plan_type']);
  const rateLimitReachedType = rec['rateLimitReachedType'] === null
    ? null
    : optionalString(rec['rateLimitReachedType'] ?? rec['rate_limit_reached_type']);
  if (
    primary === undefined &&
    secondary === undefined &&
    individualLimit === undefined &&
    limitId === undefined &&
    planType === undefined &&
    rateLimitReachedType === undefined
  ) {
    return undefined;
  }
  return {
    limitId,
    planType,
    rateLimitReachedType,
    primary: rec['primary'] === null ? null : primary,
    secondary: rec['secondary'] === null ? null : secondary,
    individualLimit,
  };
}

export function mergeCodexRateLimits(
  previous: CodexRateLimitSnapshot | undefined,
  update: CodexRateLimitSnapshot | undefined,
): CodexRateLimitSnapshot | undefined {
  if (update === undefined) return previous;
  if (update.limitId && update.limitId !== 'codex') return previous;
  if (previous === undefined) return update;
  return {
    ...previous,
    ...(update.limitId !== undefined ? { limitId: update.limitId } : {}),
    ...(update.planType !== undefined ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType !== undefined ? { rateLimitReachedType: update.rateLimitReachedType } : {}),
    ...(update.primary !== undefined ? { primary: update.primary } : {}),
    ...(update.secondary !== undefined ? { secondary: update.secondary } : {}),
    ...(update.individualLimit !== undefined ? { individualLimit: update.individualLimit } : {}),
  };
}

export function codexUsageLimitResetAt(snapshot: CodexRateLimitSnapshot | undefined): string | null {
  if (snapshot === undefined) return null;
  if (snapshot.limitId && snapshot.limitId !== 'codex') return null;
  const exhaustedResets: string[] = [];
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 100) continue;
    const iso = isoFromEpoch(window.resetsAt);
    if (iso === undefined) return null;
    exhaustedResets.push(iso);
  }
  if (snapshot.individualLimit && Number.isFinite(snapshot.individualLimit.remainingPercent)) {
    const usedPercent = 100 - snapshot.individualLimit.remainingPercent;
    if (usedPercent >= 100) {
      const iso = isoFromEpoch(snapshot.individualLimit.resetsAt);
      if (iso === undefined) return null;
      exhaustedResets.push(iso);
    }
  }
  if (exhaustedResets.length === 0) return null;
  return exhaustedResets.reduce((latest, current) =>
    Date.parse(current) > Date.parse(latest) ? current : latest,
  );
}

export function parseCodexTurnOutcome(
  rawStatus: string,
  rawError: unknown,
  rateLimits?: CodexRateLimitSnapshot,
): CodexTurnOutcome {
  const normalizedStatus: CodexTurnOutcome['status'] =
    rawStatus === 'completed' && (rawError === undefined || rawError === null)
      ? 'completed'
      : rawStatus === 'interrupted' || rawStatus === 'cancelled' || rawStatus === 'canceled'
        ? 'interrupted'
        : 'failed';

  const errRec = objectOptional(rawError);
  const nativeMessage = optionalString(errRec?.['message']) ?? (typeof rawError === 'string' ? rawError : undefined);
  const additionalDetails = optionalString(errRec?.['additionalDetails'])?.trim() || undefined;
  const errorInfo = errRec?.['codexErrorInfo'] ?? errRec?.['codex_error_info'];
  const infoCode = codexErrorInfoCode(errorInfo) ?? optionalString(errRec?.['code']);
  const httpStatusCode = codexExhaustionHttpStatus(errorInfo) ?? optionalFinite(errRec?.['httpStatusCode'] ?? errRec?.['statusCode'] ?? errRec?.['status']);
  const managed = classifyCodexManagedError(rawError);
  const errorCode = managed?.code ?? infoCode;
  const errorMessage = managed?.message ?? additionalDetails ?? nativeMessage;

  const explicitResetIso = extractCodexErrorResetAt(rawError, errorInfo);
  const snapshotResetIso = managed?.usageLimit ? undefined : (codexUsageLimitResetAt(rateLimits) ?? undefined);
  const resetAt = explicitResetIso ?? snapshotResetIso;
  const resetAtMs = resetAt !== undefined ? Date.parse(resetAt) : undefined;

  const isUsageLimit =
    managed?.usageLimit === true ||
    infoCode === 'usageLimitExceeded' ||
    infoCode === 'rateLimitExceeded' ||
    infoCode === 'usage_limit_exceeded' ||
    infoCode === 'rate_limit_exceeded' ||
    httpStatusCode === 429 ||
    isCodexUsageLimitText(errorMessage ?? '') ||
    isCodexUsageLimitText(nativeMessage ?? '');

  const usageLimit: CodexUsageLimitOutcome | undefined = normalizedStatus === 'failed' && isUsageLimit
    ? {
        code: errorCode ?? (httpStatusCode === 429 ? 'rateLimitExceeded' : 'usageLimitExceeded'),
        message: errorMessage ?? 'Codex usage limit reached.',
        httpStatusCode: httpStatusCode ?? 429,
        resetAt,
        resetAtMs: resetAtMs !== undefined && Number.isFinite(resetAtMs) ? resetAtMs : undefined,
      }
    : undefined;

  return {
    status: normalizedStatus,
    rawStatus,
    errorCode,
    errorMessage,
    additionalDetails,
    httpStatusCode,
    usageLimit,
  };
}

function textDelta(
  type: 'message.delta' | 'thought.delta',
  params: Readonly<Record<string, unknown>>,
  role?: 'assistant',
): NormalizedExecutorEvent {
  const messageId = requiredString(params['itemId'], 'delta.itemId');
  const content = { type: 'text' as const, text: requiredString(params['delta'], 'delta.delta') };
  return type === 'message.delta'
    ? { type, role: role!, messageId, content }
    : { type, messageId, content };
}

function toolStarted(
  item: Readonly<Record<string, unknown>>,
): Extract<NormalizedExecutorEvent, { readonly type: 'tool.call' }> | undefined {
  const type = requiredString(item['type'], 'item.type');
  const id = requiredString(item['id'], 'item.id');
  if (type === 'commandExecution') {
    const command = normalizeCommandExecutionCommand(item['command']);
    const rawCommand = item['command'];
    const cwd = optionalString(item['cwd']);
    return {
      type: 'tool.call',
      toolCallId: id,
      title: command ?? optionalString(rawCommand) ?? 'Command execution',
      name: 'shell',
      kind: 'command',
      status: optionalString(item['status']) ?? 'in_progress',
      rawInput: {
        command: command ?? rawCommand,
        rawCommand: command !== undefined && command !== rawCommand ? rawCommand : undefined,
        cwd,
        commandActions: item['commandActions'],
      },
      locations: cwd === undefined ? undefined : [{ path: cwd }],
    };
  }
  if (type === 'fileChange') {
    const projected = projectFileChangePayload(item['changes']);
    return {
      type: 'tool.call',
      toolCallId: id,
      title: projected.title,
      name: 'apply_patch',
      kind: 'file',
      status: optionalString(item['status']) ?? 'in_progress',
      rawInput: projected.rawInput,
      content: projected.diffs.length > 0 ? projected.diffs : undefined,
      locations: projected.locations,
    };
  }
  if (type === 'mcpToolCall') {
    const server = optionalString(item['server'])?.trim();
    const tool = optionalString(item['tool'])?.trim();
    return {
      type: 'tool.call',
      toolCallId: id,
      title: `${server || 'MCP'}/${tool || 'tool'}`,
      name: server && tool ? `mcp__${server}__${tool}` : tool,
      kind: 'mcp',
      status: optionalString(item['status']) ?? 'in_progress',
      rawInput: item['arguments'],
    };
  }
  if (type === 'webSearch') {
    return {
      type: 'tool.call',
      toolCallId: id,
      title: optionalString(item['query']) ?? 'Web search',
      name: 'web_search',
      kind: 'webSearch',
      status: optionalString(item['status']) ?? 'in_progress',
      rawInput: { query: item['query'], action: item['action'] },
    };
  }
  if (type === 'collabAgentToolCall') {
    const toolName = optionalString(item['tool']) ?? optionalString(item['name']) ?? 'Sub-agent';
    const receiverThreadIds = Array.isArray(item['receiverThreadIds'])
      ? item['receiverThreadIds'].filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    const rawArgs = objectOptional(item['arguments'] ?? item['input']);
    return {
      type: 'tool.call',
      toolCallId: id,
      title: toolName,
      name: toolName,
      kind: type,
      status: resolveCollabAgentStatus(item, false),
      rawInput: {
        ...rawArgs,
        tool: item['tool'] ?? rawArgs?.['tool'],
        prompt: optionalString(item['prompt']) ?? optionalString(rawArgs?.['prompt']),
        senderThreadId: optionalString(item['senderThreadId']) ?? optionalString(rawArgs?.['senderThreadId']),
        receiverThreadIds: receiverThreadIds ?? rawArgs?.['receiverThreadIds'],
        agentsStates: objectOptional(item['agentsStates']) ?? rawArgs?.['agentsStates'],
        model: optionalString(item['model']) ?? optionalString(rawArgs?.['model']),
        reasoningEffort: optionalString(item['reasoningEffort']) ?? optionalString(rawArgs?.['reasoningEffort']),
      },
    };
  }
  if (type === 'subAgentActivity') {
    const agentPath = optionalString(item['agentPath']);
    const humanized = humanizeSubAgentPath(agentPath);
    const activityKind = optionalString(item['kind']);
    const rawArgs = objectOptional(item['arguments'] ?? item['input']);
    const title = optionalString(item['tool']) ?? optionalString(item['name']) ?? humanized?.title ?? type;
    return {
      type: 'tool.call',
      toolCallId: id,
      title,
      name: title,
      kind: type,
      status: activityKind === 'interrupted' ? 'cancelled' : optionalString(item['status']) ?? 'in_progress',
      rawInput: {
        ...rawArgs,
        agent: humanized?.title ?? optionalString(rawArgs?.['agent']),
        prompt: optionalString(rawArgs?.['prompt']) ?? humanized?.description,
        kind: activityKind ?? rawArgs?.['kind'],
        agentThreadId: optionalString(item['agentThreadId']) ?? optionalString(rawArgs?.['agentThreadId']),
        agentPath: agentPath ?? optionalString(rawArgs?.['agentPath']),
      },
    };
  }
  if (type === 'dynamicToolCall') {
    const name = optionalString(item['tool']) ?? optionalString(item['name']) ?? type;
    return {
      type: 'tool.call',
      toolCallId: id,
      title: name,
      name,
      kind: type,
      status: optionalString(item['status']) ?? 'in_progress',
      rawInput: item['arguments'] ?? item['input'],
    };
  }
  return undefined;
}

function startedEvents(
  item: Readonly<Record<string, unknown>>,
): readonly NormalizedExecutorEvent[] {
  const itemType = requiredString(item['type'], 'item.type');
  if (
    itemType === 'agentMessage' ||
    itemType === 'reasoning' ||
    itemType === 'plan' ||
    itemType === 'userMessage'
  ) {
    return [];
  }
  const tool = toolStarted(item);
  return tool === undefined ? [unknownItemEvent('item/started', item)] : [tool];
}

function completedEvents(
  item: Readonly<Record<string, unknown>>,
): readonly NormalizedExecutorEvent[] {
  const type = requiredString(item['type'], 'item.type');
  const id = requiredString(item['id'], 'item.id');
  if (type === 'userMessage') return [];
  if (type === 'agentMessage') {
    const text = optionalString(item['text']);
    return text === undefined || text.length === 0
      ? []
      : [{ type: 'message.delta', role: 'assistant', messageId: id, content: { type: 'text', text } }];
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(item['summary'])
      ? item['summary'].filter((value): value is string => typeof value === 'string').join('\n\n')
      : undefined;
    return summary === undefined || summary.length === 0
      ? []
      : [{ type: 'thought.delta', messageId: id, content: { type: 'text', text: summary } }];
  }
  if (type === 'plan') {
    return [{ type: 'plan.update', plan: item, unstable: false }];
  }
  const started = toolStarted(item);
  if (started === undefined) return [unknownItemEvent('item/completed', item)];

  if (type === 'commandExecution') {
    const rawAggregated = optionalString(item['aggregatedOutput']);
    const cleanedOutput = extractCodexShellOutput(rawAggregated);
    const exitCode = optionalFinite(item['exitCode']);
    const status = terminalCommandStatus(item, exitCode);
    const rawOutput = cleanedOutput !== undefined
      ? cleanedOutput
      : item['aggregatedOutput'] ?? item['result'] ?? item['error'];
    return [{
      type: 'tool.update',
      toolCallId: id,
      title: started.title,
      name: started.name,
      kind: started.kind,
      status,
      rawInput: started.rawInput,
      rawOutput,
      locations: started.locations,
      errorCode: toolErrorCode(type, item),
    }];
  }

  if (type === 'fileChange') {
    const projected = projectFileChangePayload(item['changes']);
    return [{
      type: 'tool.update',
      toolCallId: id,
      title: projected.title,
      name: started.name,
      kind: started.kind,
      status: terminalStatus(item),
      rawInput: projected.rawInput,
      rawOutput: item['error'] ?? projected.rawOutput,
      content: projected.diffs.length > 0 ? projected.diffs : undefined,
      locations: projected.locations,
      errorCode: toolErrorCode(type, item),
    }];
  }

  if (type === 'mcpToolCall') {
    const { images, output } = splitCodexMcpToolResultImages(item['result']);
    const content = images.length > 0
      ? images.map((image) => ({
          type: 'image' as const,
          mimeType: image.mimeType,
          data: image.data,
          uri: image.uri,
        }))
      : undefined;
    return [{
      type: 'tool.update',
      toolCallId: id,
      title: started.title,
      name: started.name,
      kind: started.kind,
      status: terminalStatus(item),
      rawInput: started.rawInput,
      rawOutput: output ?? item['error'],
      content,
      errorCode: toolErrorCode(type, item),
    }];
  }

  if (type === 'collabAgentToolCall') {
    return [{
      type: 'tool.update',
      toolCallId: id,
      title: started.title,
      name: started.name,
      kind: started.kind,
      status: resolveCollabAgentStatus(item, true),
      rawInput: started.rawInput,
      rawOutput: item['result'] ?? item['error'] ?? item['agentsStates'],
      errorCode: toolErrorCode(type, item),
    }];
  }

  if (type === 'subAgentActivity') {
    const activityKind = optionalString(item['kind']);
    return [{
      type: 'tool.update',
      toolCallId: id,
      title: started.title,
      name: started.name,
      kind: started.kind,
      status: activityKind === 'interrupted' ? 'cancelled' : terminalStatus(item),
      rawInput: started.rawInput,
      rawOutput: item['result'] ?? item['error'] ?? {
        kind: activityKind,
        agentThreadId: item['agentThreadId'],
        agentPath: item['agentPath'],
      },
      errorCode: toolErrorCode(type, item),
    }];
  }

  return [{
    type: 'tool.update',
    toolCallId: id,
    title: started.title,
    name: started.name,
    kind: started.kind,
    status: terminalStatus(item),
    rawInput: started.rawInput,
    rawOutput: item['aggregatedOutput'] ?? item['result'] ?? item['error'] ?? item['changes'],
    errorCode: toolErrorCode(type, item),
  }];
}

function projectFileChangePayload(rawChanges: unknown): {
  readonly files: readonly CodexFileChangeEntry[];
  readonly diffs: readonly CodexStructuredFileDiff[];
  readonly title: string;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  readonly locations?: readonly { readonly path: string }[];
} {
  const files = parseCodexFileChanges(rawChanges);
  if (files.length === 0) {
    return {
      files: [],
      diffs: [],
      title: 'File change',
      rawInput: rawChanges,
      rawOutput: rawChanges,
    };
  }
  const diffs = extractStructuredFileDiffs(files);
  const preview = fileChangesToPreview(files);
  const paths = uniqueStrings(files.map((file) => file.movePath ?? file.path));
  const title = paths.length === 1 ? paths[0]! : `File change (${paths.length} files)`;
  const structuredFiles = files.map((file) => ({
    path: file.path,
    kind: file.kind,
    movePath: file.movePath,
  }));
  const structuredPayload = {
    files: structuredFiles,
    path: paths.length === 1 ? paths[0] : undefined,
    patch: preview.unifiedDiff.length > 0 ? preview.unifiedDiff : undefined,
  };
  return {
    files,
    diffs,
    title,
    rawInput: Array.isArray(rawChanges) && diffs.length === 0 ? rawChanges : structuredPayload,
    rawOutput: preview.unifiedDiff.length > 0 ? preview.unifiedDiff : structuredPayload,
    locations: paths.map((path) => ({ path })),
  };
}

/**
 * Codex reports this refusal only as text (`codex-rs/core/src/mcp_tool_call.rs`,
 * `request_mcp_tool_user_approval`); the adapter is the one place that reads
 * it, so every consumer downstream sees a stable code instead.
 */
function toolErrorCode(type: string, item: Readonly<Record<string, unknown>>): string | undefined {
  if (type !== 'mcpToolCall') return undefined;
  const error = item['error'];
  const message = typeof error === 'object' && error !== null ? optionalString((error as Record<string, unknown>)['message']) : undefined;
  return message !== undefined && /requires approval, but approval policy is never/i.test(message)
    ? CODEX_MCP_APPROVAL_DENIED : undefined;
}

function unknownItemEvent(
  boundary: 'item/started' | 'item/completed',
  item: Readonly<Record<string, unknown>>,
): NormalizedExecutorEvent {
  return {
    type: 'unknown',
    updateType: `${boundary}:${requiredString(item['type'], 'item.type')}`,
  };
}

function terminalCommandStatus(item: Readonly<Record<string, unknown>>, exitCode: number | undefined): string {
  const base = terminalStatus(item);
  if (base !== 'completed') return base;
  return exitCode !== undefined && exitCode !== 0 ? 'failed' : 'completed';
}

function terminalStatus(item: Readonly<Record<string, unknown>>): string {
  const status = optionalString(item['status'])?.trim().toLowerCase();
  if (status === 'cancelled' || status === 'canceled' || status === 'interrupted' || status === 'aborted') {
    return 'cancelled';
  }
  return status === 'failed' || status === 'declined' || status === 'error' || status === 'errored' || (item['error'] !== undefined && item['error'] !== null)
    ? 'failed'
    : 'completed';
}

function resolveCollabAgentStatus(
  item: Readonly<Record<string, unknown>>,
  completedBoundary: boolean,
): string {
  if (item['error'] !== undefined && item['error'] !== null) return 'failed';
  const rawParent = optionalString(item['status'])?.trim().toLowerCase();
  if (rawParent === 'failed' || rawParent === 'declined' || rawParent === 'error' || rawParent === 'errored') {
    return 'failed';
  }
  if (rawParent === 'cancelled' || rawParent === 'canceled' || rawParent === 'interrupted') {
    return 'cancelled';
  }
  const statesRec = objectOptional(item['agentsStates']);
  if (statesRec !== undefined) {
    const childStatuses = Object.values(statesRec)
      .map((entry) => optionalString(objectOptional(entry)?.['status']) ?? optionalString(entry))
      .filter((value): value is string => value !== undefined && value.trim().length > 0)
      .map((value) => {
        const lower = value.trim().toLowerCase();
        if (lower === 'error' || lower === 'errored') return 'in_progress';
        if (lower === 'shutdown' || lower === 'cancelled' || lower === 'canceled' || lower === 'interrupted') return 'cancelled';
        if (lower === 'failed' || lower === 'notfound' || lower === 'not_found' || lower === 'declined') return 'failed';
        if (lower === 'completed' || lower === 'complete' || lower === 'done' || lower === 'succeeded') return 'completed';
        return 'in_progress';
      });
    if (childStatuses.some((status) => status === 'failed')) return 'failed';
    if (childStatuses.some((status) => status === 'cancelled')) return 'cancelled';
    if (childStatuses.length > 0) {
      return childStatuses.every((status) => status === 'completed')
        ? 'completed'
        : completedBoundary && rawParent === 'completed'
          ? 'completed'
          : 'in_progress';
    }
  }
  if (rawParent === 'completed') return 'completed';
  return completedBoundary ? 'completed' : 'in_progress';
}

function humanizeSubAgentPath(agentPath: string | undefined): { readonly title: string; readonly description: string } | undefined {
  if (agentPath === undefined || agentPath.trim().length === 0) return undefined;
  let nativeName = agentPath.trim();
  if (nativeName === '/root') {
    nativeName = '';
  } else if (nativeName.startsWith('/root/')) {
    nativeName = nativeName.slice('/root/'.length);
  } else if (/[\\/]/.test(nativeName)) {
    nativeName = nativeName.slice(Math.max(nativeName.lastIndexOf('/'), nativeName.lastIndexOf('\\')) + 1);
  }
  const description = nativeName;
  const title = nativeName
    .split('/')
    .map((segment) => segment.replaceAll(/[_-]+/g, ' ').trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]!.toUpperCase()}${segment.slice(1)}`)
    .join(' / ') || 'Sub-agent';
  return { title, description };
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const unix = /^(?:(?:\/[^/\s]+)*\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\s\S]+)$/.exec(trimmed);
  if (unix?.[1]) return stripMatchingEdgeQuotes(unix[1].trim());
  const windows = /^(?:"[^"]*\\)?(?:pwsh|powershell|cmd)(?:\.exe)?"?(?:\s+-[A-Za-z]+(?:\s+[^-\s][^\s]*)?)*\s+(?:-Command|-c|\/c)\s+([\s\S]+)$/i.exec(trimmed);
  return windows?.[1] ? stripMatchingEdgeQuotes(windows[1].trim()) : trimmed;
}

function stripMatchingEdgeQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isWindowsShellCommand(command: string): boolean {
  const normalized = command.replaceAll(/^["']|["']$/g, '');
  return /(?:^|[\\/])(?:pwsh|powershell|cmd)(?:\.exe)?$/i.test(normalized);
}

function isCodexShellEnvelopeHeaderLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return CODEX_SHELL_ENVELOPE_HEADER_LINES.some((prefix) => normalized.startsWith(prefix));
}

function looksLikeCodexShellEnvelope(lines: readonly string[]): boolean {
  if (lines.length === 0) return false;
  const first = lines[0]?.trim().toLowerCase() ?? '';
  if (!first.startsWith('chunk id:')) return false;
  const headerWindow = lines.slice(0, 8).map((line) => line.trim().toLowerCase());
  const hasWallTime = headerWindow.some((line) => line.startsWith('wall time:'));
  const hasExitCode = headerWindow.some((line) => line.startsWith('process exited with code'));
  return hasWallTime && hasExitCode;
}

function looksLikeUnifiedDiff(text: string): boolean {
  const normalized = text.trimStart();
  return (
    normalized.startsWith('diff --git') ||
    normalized.startsWith('@@') ||
    normalized.startsWith('--- ') ||
    normalized.startsWith('+++ ')
  );
}

function looksLikeCodexApplyPatch(text: string): boolean {
  const normalized = text.trimStart();
  if (!normalized) return false;
  if (normalized.startsWith('*** Begin Patch')) return true;
  return text.split(/\r?\n/).some((line) => parseCodexApplyPatchDirective(line) !== undefined);
}

function parseCodexApplyPatchDirective(line: string): { readonly kind: 'add' | 'update' | 'delete'; readonly path: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith('*** Add File:')) {
    return { kind: 'add', path: trimmed.slice('*** Add File:'.length).trim() };
  }
  if (trimmed.startsWith('*** Update File:')) {
    return { kind: 'update', path: trimmed.slice('*** Update File:'.length).trim() };
  }
  if (trimmed.startsWith('*** Delete File:')) {
    return { kind: 'delete', path: trimmed.slice('*** Delete File:'.length).trim() };
  }
  return undefined;
}

function normalizeDiffHeaderPath(rawPath: string): string {
  return rawPath.trim().replaceAll(/^["']+|["']+$/g, '');
}

function parseUnifiedDiffEntries(diffText: string): CodexFileChangeEntry[] {
  const lines = diffText.replaceAll('\r\n', '\n').split('\n');
  const entries: CodexFileChangeEntry[] = [];
  let currentPath: string | undefined;
  let currentKind: string | undefined;
  let currentMovePath: string | undefined;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentLines.length === 0) return;
    const path = currentPath ?? inferPathFromUnifiedLines(currentLines);
    if (path !== undefined) {
      entries.push({
        path,
        kind: currentKind,
        movePath: currentMovePath && currentMovePath !== path ? currentMovePath : undefined,
        diff: currentLines.join('\n').trim(),
      });
    }
    currentPath = undefined;
    currentKind = undefined;
    currentMovePath = undefined;
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trim());
      if (match) {
        currentPath = normalizeDiffHeaderPath(match[1]!);
        const dest = normalizeDiffHeaderPath(match[2]!);
        if (dest !== currentPath) currentMovePath = dest;
      }
      currentLines.push(line);
      continue;
    }
    if (line.startsWith('--- ') && currentLines.length > 0 && !currentLines[0]?.startsWith('diff --git ') && currentLines.some((l) => l.startsWith('@@'))) {
      flush();
    }
    if (line.startsWith('--- /dev/null')) currentKind = 'add';
    else if (line.startsWith('+++ /dev/null')) currentKind = 'delete';
    else if (line.startsWith('rename from ')) currentPath = normalizeDiffHeaderPath(line.slice('rename from '.length));
    else if (line.startsWith('rename to ')) currentMovePath = normalizeDiffHeaderPath(line.slice('rename to '.length));
    currentLines.push(line);
  }
  flush();
  return entries;
}

function inferPathFromUnifiedLines(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      return normalizeDiffHeaderPath(line.slice(4)).replace(/^b\//, '');
    }
    if (line.startsWith('--- ') && line !== '--- /dev/null') {
      return normalizeDiffHeaderPath(line.slice(4)).replace(/^a\//, '');
    }
  }
  return undefined;
}

function oldAndNewFromUnifiedDiff(diff: string): {
  readonly before: string;
  readonly after: string;
  readonly sawHunk: boolean;
  readonly isAdd: boolean;
} {
  const lines = diff.replaceAll('\r\n', '\n').split('\n');
  const beforeChunks: string[][] = [];
  const afterChunks: string[][] = [];
  let currentBefore: string[] | undefined;
  let currentAfter: string[] | undefined;
  let isAdd = false;

  for (const line of lines) {
    if (line.startsWith('--- /dev/null')) {
      isAdd = true;
      continue;
    }
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('@@')) {
      currentBefore = [];
      currentAfter = [];
      beforeChunks.push(currentBefore);
      afterChunks.push(currentAfter);
      continue;
    }
    if (line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('-') || line.startsWith('+') || line.startsWith(' ')) {
      if (currentBefore === undefined || currentAfter === undefined) {
        currentBefore = [];
        currentAfter = [];
        beforeChunks.push(currentBefore);
        afterChunks.push(currentAfter);
      }
      const text = line.slice(1);
      if (line.startsWith('-')) currentBefore.push(text);
      else if (line.startsWith('+')) currentAfter.push(text);
      else {
        currentBefore.push(text);
        currentAfter.push(text);
      }
    }
  }
  return {
    before: beforeChunks.map((chunk) => chunk.join('\n')).join('\n...\n'),
    after: afterChunks.map((chunk) => chunk.join('\n')).join('\n...\n'),
    sawHunk: beforeChunks.length > 0,
    isAdd,
  };
}

function parseFileChangePath(entry: Readonly<Record<string, unknown>>, fallbackPath?: string): string | undefined {
  return pickFirstNonEmptyString([
    entry['path'],
    entry['file_path'],
    entry['filePath'],
    fallbackPath,
  ])?.trim();
}

function parseFileChangeKind(entry: Readonly<Record<string, unknown>>): string | undefined {
  const kindRec = objectOptional(entry['kind']);
  if (kindRec !== undefined && typeof kindRec['type'] === 'string') return kindRec['type'];
  return pickFirstNonEmptyString([entry['kind'], entry['type']]);
}

function toFileChangeEntry(
  entry: Readonly<Record<string, unknown>>,
  fallbackPath?: string,
): CodexFileChangeEntry | undefined {
  const path = parseFileChangePath(entry, fallbackPath);
  if (path === undefined || path.length === 0) return undefined;
  const kindRec = objectOptional(entry['kind']);
  const movePath = pickFirstNonEmptyString([
    entry['move_path'],
    entry['movePath'],
    kindRec?.['move_path'],
    kindRec?.['movePath'],
  ])?.trim();
  const explicitDiff = pickFirstNonEmptyString([
    entry['diff'],
    entry['patch'],
    entry['unified_diff'],
    entry['unifiedDiff'],
    entry['content'],
    entry['newString'],
    entry['new_string'],
    entry['newText'],
  ]);
  const oldStr = typeof entry['oldString'] === 'string'
    ? entry['oldString']
    : typeof entry['old_string'] === 'string'
      ? entry['old_string']
      : typeof entry['oldText'] === 'string'
        ? entry['oldText']
        : undefined;
  const newStr = typeof entry['newString'] === 'string'
    ? entry['newString']
    : typeof entry['new_string'] === 'string'
      ? entry['new_string']
      : typeof entry['newText'] === 'string'
        ? entry['newText']
        : undefined;
  const synthesizedDiff = oldStr !== undefined && newStr !== undefined
    ? pairToUnifiedDiff(path, oldStr, newStr, movePath)
    : explicitDiff;
  return {
    path,
    kind: parseFileChangeKind(entry),
    diff: synthesizedDiff,
    movePath,
  };
}

function pairToUnifiedDiff(path: string, oldText: string, newText: string, movePath?: string): string {
  const dest = movePath ?? path;
  const oldLines = oldText.length === 0 ? [] : oldText.replaceAll('\r\n', '\n').split('\n');
  const newLines = newText.length === 0 ? [] : newText.replaceAll('\r\n', '\n').split('\n');
  return [
    `diff --git a/${path} b/${dest}`,
    `--- a/${path}`,
    `+++ b/${dest}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

function contentToDeletionDiff(filePath: string, content: string): string {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  const output = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    '+++ /dev/null',
  ];
  const nonEmpty = lines.length > 0 && lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  if (nonEmpty.some((line) => line.length > 0)) {
    output.push(`@@ -1,${nonEmpty.length} +0,0 @@`);
    for (const line of nonEmpty) output.push(`-${line}`);
  }
  return output.join('\n');
}

function resolveFileChangeTextFields(file: CodexFileChangeEntry): {
  readonly unifiedDiff?: string;
  readonly newString?: string;
} {
  if (file.kind === 'delete') {
    if (file.diff !== undefined && file.diff.length > 0) {
      if (looksLikeUnifiedDiff(file.diff)) return { unifiedDiff: truncateDiffText(file.diff) };
      if (looksLikeCodexApplyPatch(file.diff)) {
        return { unifiedDiff: truncateDiffText(codexApplyPatchToUnifiedDiff(file.diff)) };
      }
      return { unifiedDiff: truncateDiffText(contentToDeletionDiff(file.path, file.diff)) };
    }
    return { unifiedDiff: contentToDeletionDiff(file.path, '') };
  }
  if (file.diff === undefined || file.diff.length === 0) return {};
  if (looksLikeUnifiedDiff(file.diff)) return { unifiedDiff: truncateDiffText(file.diff) };
  if (looksLikeCodexApplyPatch(file.diff)) {
    return { unifiedDiff: truncateDiffText(codexApplyPatchToUnifiedDiff(file.diff)) };
  }
  return { newString: file.diff };
}

function fileChangeToUnifiedDiff(file: CodexFileChangeEntry): string {
  const isMoveOnlyNotice = Boolean(file.movePath && file.diff?.startsWith('\n\nMoved to: '));
  const { unifiedDiff, newString } = isMoveOnlyNotice ? {} : resolveFileChangeTextFields(file);
  if (!unifiedDiff && !newString) {
    if (file.kind === 'add') {
      return [
        `diff --git a/${file.path} b/${file.path}`,
        '--- /dev/null',
        `+++ b/${file.path}`,
      ].join('\n');
    }
    return file.movePath
      ? [
          `diff --git a/${file.path} b/${file.movePath}`,
          `rename from ${file.path}`,
          `rename to ${file.movePath}`,
        ].join('\n')
      : '';
  }
  if (unifiedDiff?.startsWith('diff --git')) return unifiedDiff.replace(/\r?\n$/, '');
  const destination = file.movePath ?? file.path;
  const header = `diff --git a/${file.path} b/${destination}`;
  if (unifiedDiff?.startsWith('--- ')) return `${header}\n${unifiedDiff.replace(/\r?\n$/, '')}`;
  const left = file.kind === 'add' ? '/dev/null' : `a/${file.path}`;
  const right = file.kind === 'delete' ? '/dev/null' : `b/${destination}`;
  const lines = [header, `--- ${left}`, `+++ ${right}`];
  if (unifiedDiff) {
    lines.push(unifiedDiff.replace(/\r?\n$/, ''));
  } else if (newString) {
    const contentLines = newString.replaceAll('\r\n', '\n').replace(/\n$/, '').split('\n');
    lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
    for (const line of contentLines) lines.push(`+${line}`);
  }
  return lines.join('\n');
}

function splitFileDiffPreview(diff: string): { readonly header: string; readonly body: string } {
  const hunk = diff.indexOf('\n@@');
  const bodyStart = hunk < 0 ? -1 : diff.indexOf('\n', hunk + 1);
  return bodyStart < 0
    ? { header: diff, body: '' }
    : { header: diff.slice(0, bodyStart + 1), body: diff.slice(bodyStart + 1) };
}

function truncateDiffText(text: string, maxChars = CODEX_TOOL_CALL_DIFF_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const truncatedCount = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n...[truncated ${truncatedCount} chars]`;
}

function parseRateLimitWindow(value: unknown): CodexRateLimitWindow | undefined {
  const rec = objectOptional(value);
  if (rec === undefined) return undefined;
  const usedPercent = optionalFinite(rec['usedPercent'] ?? rec['used_percent']);
  if (usedPercent === undefined) return undefined;
  const resetsAt = parseEpochSeconds(rec['resetsAt'] ?? rec['resets_at'] ?? rec['resetAt'] ?? rec['reset_at']);
  const windowDurationMins = optionalFinite(rec['windowDurationMins'] ?? rec['window_duration_mins']);
  return {
    usedPercent,
    resetsAt: rec['resetsAt'] === null || rec['resets_at'] === null ? null : resetsAt,
    windowDurationMins: rec['windowDurationMins'] === null || rec['window_duration_mins'] === null ? null : windowDurationMins,
  };
}

function parseEpochSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e11 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num > 1e11 ? Math.floor(num / 1000) : num;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return undefined;
}

function isoFromEpoch(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value > 1e11 ? value : value * 1000;
  if (ms >= 8.64e15) return undefined;
  return new Date(ms).toISOString();
}

function codexErrorInfoCode(errorInfo: unknown): string | undefined {
  if (typeof errorInfo === 'string' && errorInfo.trim().length > 0) return errorInfo.trim();
  const rec = objectOptional(errorInfo);
  if (rec === undefined) return undefined;
  if (typeof rec['type'] === 'string' && rec['type'].trim().length > 0) return rec['type'].trim();
  const keys = Object.keys(rec);
  return keys.length === 1 ? keys[0] : undefined;
}

function codexExhaustionHttpStatus(errorInfo: unknown): number | undefined {
  const rec = objectOptional(errorInfo);
  if (rec === undefined) return undefined;
  const attempts = objectOptional(rec['responseTooManyFailedAttempts'] ?? rec['response_too_many_failed_attempts']);
  return optionalFinite(attempts?.['httpStatusCode'] ?? attempts?.['http_status_code'] ?? rec['httpStatusCode'] ?? rec['http_status_code']);
}

function extractCodexErrorResetAt(rawError: unknown, errorInfo: unknown): string | undefined {
  const candidates: unknown[] = [];
  const errRec = objectOptional(rawError);
  const infoRec = objectOptional(errorInfo);
  const nestedUsage = infoRec ? objectOptional(infoRec['usageLimitExceeded'] ?? infoRec['rateLimitExceeded']) : undefined;
  for (const source of [nestedUsage, infoRec, errRec]) {
    if (!source) continue;
    candidates.push(
      source['resetsAt'],
      source['resets_at'],
      source['resetAt'],
      source['reset_at'],
    );
    const retryAfterSec = optionalFinite(source['retryAfterSeconds'] ?? source['retry_after_seconds'] ?? source['resetsInSeconds'] ?? source['resets_in_seconds']);
    if (retryAfterSec !== undefined && retryAfterSec > 0) {
      return new Date(Date.now() + retryAfterSec * 1000).toISOString();
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      const iso = isoFromEpoch(candidate);
      if (iso !== undefined) return iso;
    }
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0) {
        const iso = isoFromEpoch(numeric);
        if (iso !== undefined) return iso;
      }
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 8.64e15) {
        return new Date(parsed).toISOString();
      }
    }
  }
  for (const text of [optionalString(errRec?.['additionalDetails']), optionalString(errRec?.['message']), typeof rawError === 'string' ? rawError : undefined]) {
    if (!text) continue;
    const jsonReset = extractResetFromEmbeddedJson(text);
    if (jsonReset !== undefined) return jsonReset;
    const isoMatch = /\b(?:resets?\s+at|resetAt|resets_at)[:=\s]+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i.exec(text);
    if (isoMatch?.[1]) {
      const parsed = Date.parse(isoMatch[1]);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

function extractResetFromEmbeddedJson(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    const root = objectOptional(parsed);
    const inner = objectOptional(root?.['error']) ?? root;
    if (inner === undefined) return undefined;
    const direct = inner['resets_at'] ?? inner['resetsAt'] ?? inner['reset_at'] ?? inner['resetAt'] ?? root?.['resets_at'] ?? root?.['resetsAt'];
    if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return isoFromEpoch(direct);
    if (typeof direct === 'string' && direct.trim().length > 0) {
      const num = Number(direct);
      if (Number.isFinite(num) && num > 0) return isoFromEpoch(num);
      const ts = Date.parse(direct);
      if (Number.isFinite(ts) && ts > 0) return new Date(ts).toISOString();
    }
    const seconds = optionalFinite(inner['resets_in_seconds'] ?? inner['retry_after']);
    if (seconds !== undefined && seconds > 0) return new Date(Date.now() + seconds * 1000).toISOString();
  } catch {
    return undefined;
  }
  return undefined;
}

function classifyCodexManagedError(value: unknown): { readonly code: string; readonly message: string; readonly usageLimit: boolean } | undefined {
  const unwrapped = unwrapEmbeddedError(value);
  const rec = objectOptional(unwrapped);
  const messages = typeof unwrapped === 'string'
    ? [unwrapped]
    : rec !== undefined
      ? [optionalString(rec['message']), optionalString(rec['additionalDetails'])].filter((m): m is string => m !== undefined)
      : [];
  const directCode = managedErrorCode(unwrapped) ?? messages.map(managedErrorCode).find((code) => code !== undefined) ??
    (messages.some((message) => message.includes('has reached their Subscription Sharing usage limit'))
      ? 'subscription_sharing_usage_limit_exceeded'
      : undefined);
  if (directCode === undefined) return undefined;
  const base = CODEX_MANAGED_ERRORS[directCode]!;
  const combined = messages.join(' ');
  if (directCode === 'subscription_sharing_unsupported_capability') {
    if (combined.includes("tool 'namespace'")) {
      return {
        code: directCode,
        message: 'Codex sent a tool namespace that ChatGPT sharing does not support. Use another provider for this request.',
        usageLimit: false,
      };
    }
    if (combined.includes('additional_tools')) {
      return {
        code: directCode,
        message: 'Codex sent an input item that ChatGPT sharing does not support. Use another provider for this request.',
        usageLimit: false,
      };
    }
  }
  return { code: directCode, message: base.message, usageLimit: base.usageLimit };
}

function unwrapEmbeddedError(value: unknown): unknown {
  let current = value;
  if (typeof current === 'string') {
    const trimmed = current.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        current = JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return value;
      }
    } else {
      return value;
    }
  }
  const rec = objectOptional(current);
  return rec !== undefined && 'error' in rec ? rec['error'] : current;
}

function managedErrorCode(value: unknown): string | undefined {
  const unwrapped = unwrapEmbeddedError(value);
  const candidate = typeof unwrapped === 'string'
    ? unwrapped
    : optionalString(objectOptional(unwrapped)?.['code']);
  return candidate !== undefined && Object.hasOwn(CODEX_MANAGED_ERRORS, candidate)
    ? candidate
    : undefined;
}

function isCodexUsageLimitText(text: string): boolean {
  if (!text) return false;
  return /usage[_\s-]*limit|rate[_\s-]*limit|quota[_\s-]*(?:exceeded|reached)|insufficient[_\s-]*quota|\btoo\s+many\s+requests\b/i.test(text);
}

function pickFirstNonEmptyString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexClientError('protocol', `${name} must be an object`, value);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new CodexClientError('protocol', `${name} must be a string`, value);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function objectOptional(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CodexClientError('protocol', `${name} must be finite`, value);
  }
  return value;
}

function optionalFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
