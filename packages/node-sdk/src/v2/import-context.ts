/**
 * v2 import-context construction — pure functions that replicate, byte for
 * byte, the user message v1's `ContextMemory.importContext`
 * (`packages/agent-core/src/agent/context/index.ts`) appends for an
 * `importContext` RPC. Message validation stays here; the atomic core
 * operation owns busy, capacity, and append admission.
 *
 * The wrapper format, guidance text, and XML escapers below are copied from
 * v1 (`agent/core/src/agent/context` and `agent-core/src/utils/xml-escape.ts`);
 * keep them byte-identical with those sources so a v1-written and a
 * v2-written import reduce to the same history.
 */
import { ErrorCodes, KimiError } from '#/errors';
import type { ContextMessage } from '@kiki/agent-core-v2';

/** Byte-identical with v1's `IMPORT_CONTEXT_GUIDANCE`. */
const IMPORT_CONTEXT_GUIDANCE =
  'This is a prior conversation history that may be relevant to the current session. ' +
  'Please review this context and use it to inform your responses.';

/** Byte-identical with v1's `escapeXml` (& < > "). */
function escapeXml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Byte-identical with v1's `escapeXmlAttr` (& " only). */
function escapeXmlAttr(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/**
 * The exact message v1 appends for an import, including its rejections:
 * blank content (`import_content_empty`) and blank source
 * (`import_source_empty`) fail with v1's `request.invalid` shapes before any
 * token math runs.
 */
export function buildImportContextMessage(content: string, source: string): ContextMessage {
  if (content.trim().length === 0) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Imported context cannot be empty', {
      details: { reason: 'import_content_empty' },
    });
  }
  const normalizedSource = source.trim();
  if (normalizedSource.length === 0) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Imported context source cannot be empty', {
      details: { reason: 'import_source_empty' },
    });
  }
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `<system>The user has imported context from ${escapeXml(normalizedSource)}. ` +
          `${IMPORT_CONTEXT_GUIDANCE}</system>`,
      },
      {
        type: 'text',
        text:
          `<imported_context source="${escapeXmlAttr(normalizedSource)}">\n` +
          `${content}\n</imported_context>`,
      },
    ],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}
