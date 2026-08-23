import {
  classifyToolArgsJson,
  type JsonTailClassification,
} from '#/tool/json-tail';

export type { JsonTailClassification, JsonTailKind } from '#/tool/json-tail';
export { classifyToolArgsJson } from '#/tool/json-tail';

export type ToolArgsTruncation = {
  readonly kind: 'container-unclosed' | 'value-truncated';
  readonly offset: number;
  readonly field?: string;
};

export type ParseToolCallArgumentsResult = {
  readonly data: unknown;
  readonly parseFailed: boolean;
  readonly error?: string;
  readonly repaired?: boolean;
  readonly truncation?: ToolArgsTruncation;
};

const RAW_ARGS_PREVIEW_LIMIT = 2048;

/**
 * Parse tool-call arguments JSON, repairing only unclosed containers whose values are complete.
 */
export function parseToolCallArguments(raw: unknown): ParseToolCallArgumentsResult {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.length === 0)) {
    return { data: {}, parseFailed: false };
  }
  if (typeof raw !== 'string') {
    return { data: raw, parseFailed: false };
  }
  try {
    return { data: JSON.parse(raw) as unknown, parseFailed: false };
  } catch (error) {
    const classification = classifyToolArgsJson(raw);
    if (classification.kind === 'container-unclosed') {
      try {
        return {
          data: JSON.parse(raw + classification.closers) as unknown,
          parseFailed: false,
          repaired: true,
          truncation: toTruncation(classification),
        };
      } catch {
        return failedParse(error);
      }
    }
    if (classification.kind === 'value-truncated') {
      return failedParse(error, toTruncation(classification));
    }
    return failedParse(error);
  }
}

/**
 * Model-facing rejection text for truncated tool-call arguments.
 */
export function formatToolArgsTruncationRejection(
  toolName: string,
  raw: unknown,
  truncation: ToolArgsTruncation,
  unexecuted: boolean,
): string {
  const rawText = typeof raw === 'string' ? raw : '';
  const cause =
    truncation.kind === 'value-truncated'
      ? truncation.field === undefined
        ? 'incomplete value'
        : `incomplete value in field "${truncation.field}"`
      : truncation.field === undefined
        ? 'unclosed container'
        : `unclosed container in field "${truncation.field}"`;
  const head = unexecuted
    ? `This tool call was not executed: arguments JSON for tool "${toolName}" was truncated at byte ${String(truncation.offset)} (${cause}). Do not assume the tool ran.`
    : `Arguments JSON for tool "${toolName}" was truncated at byte ${String(truncation.offset)} (${cause}). Do not retry the same arguments.`;
  const next =
    truncation.field === undefined
      ? ' Re-issue the call with shorter arguments.'
      : ` Re-issue the call with a shorter value for "${truncation.field}".`;
  if (rawText.length === 0) return `${head}${next}`;
  return `${head}${next}\n\nRaw arguments (${String(rawText.length)} chars):\n${formatRawArgsPreview(rawText)}`;
}

function formatRawArgsPreview(raw: string): string {
  if (raw.length <= RAW_ARGS_PREVIEW_LIMIT) return raw;
  const omitted = raw.length - RAW_ARGS_PREVIEW_LIMIT;
  return `${raw.slice(0, RAW_ARGS_PREVIEW_LIMIT)}\n… [${String(omitted)} chars omitted]`;
}

function toTruncation(
  classification: Extract<JsonTailClassification, { kind: 'container-unclosed' | 'value-truncated' }>,
): ToolArgsTruncation {
  if (classification.field === undefined) {
    return { kind: classification.kind, offset: classification.offset };
  }
  return { kind: classification.kind, offset: classification.offset, field: classification.field };
}

function failedParse(error: unknown, truncation?: ToolArgsTruncation): ParseToolCallArgumentsResult {
  if (truncation === undefined) {
    return {
      data: {},
      parseFailed: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    data: {},
    parseFailed: true,
    error: error instanceof Error ? error.message : String(error),
    truncation,
  };
}
