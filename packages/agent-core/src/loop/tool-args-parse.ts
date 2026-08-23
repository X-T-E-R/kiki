import { errorMessage } from './errors';
import {
  classifyToolArgsJson,
  type JsonTailClassification,
} from './json-tail';

export type { JsonTailClassification, JsonTailKind } from './json-tail';
export { classifyToolArgsJson } from './json-tail';

export type ToolArgsTruncation = {
  readonly kind: 'container-unclosed' | 'value-truncated';
  readonly offset: number;
  readonly field?: string;
};

export type ParseToolArgsResult = {
  readonly success: true;
  readonly data: unknown;
  readonly parseFailed: boolean;
  readonly error?: string;
  readonly repaired?: boolean;
  readonly truncation?: ToolArgsTruncation;
};

const RAW_ARGS_PREVIEW_LIMIT = 2048;

export function parseToolCallArguments(raw: string | null): ParseToolArgsResult {
  if (raw === null || raw.length === 0) {
    return { success: true, data: {}, parseFailed: false };
  }

  try {
    return { success: true, data: JSON.parse(raw) as unknown, parseFailed: false };
  } catch (error) {
    const classification = classifyToolArgsJson(raw);
    if (classification.kind === 'container-unclosed') {
      try {
        return {
          success: true,
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

export function formatToolArgsTruncationRejection(
  toolName: string,
  raw: string | null,
  truncation: ToolArgsTruncation,
  unexecuted: boolean,
): string {
  const rawText = raw ?? '';
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

function failedParse(error: unknown, truncation?: ToolArgsTruncation): ParseToolArgsResult {
  if (truncation === undefined) {
    return {
      success: true,
      data: {},
      parseFailed: true,
      error: errorMessage(error),
    };
  }
  return {
    success: true,
    data: {},
    parseFailed: true,
    error: errorMessage(error),
    truncation,
  };
}
