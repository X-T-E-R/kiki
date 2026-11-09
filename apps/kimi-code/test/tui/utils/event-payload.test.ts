import { ErrorCodes, KimiError } from '@kiki/node-sdk';
import { describe, expect, it } from 'vitest';

import { STREAMING_ARGS_PREVIEW_MAX_CHARS } from '#/tui/constant/streaming';
import {
  appendStreamingArgsPreview,
  formatErrorMessage,
  formatErrorPayload,
  parseStreamingArgs,
} from '#/tui/utils/event-payload';

describe('streaming tool argument payload helpers', () => {
  it('parses complete JSON arguments for finalized small previews', () => {
    expect(parseStreamingArgs('{"command":"echo hi","path":"/tmp/a"}')).toEqual({
      command: 'echo hi',
      path: '/tmp/a',
    });
  });

  it('caps accumulated streaming preview text', () => {
    const current = 'a'.repeat(STREAMING_ARGS_PREVIEW_MAX_CHARS - 2);

    expect(appendStreamingArgsPreview(current, 'bcdef')).toBe(`${current}bc`);
  });

  it('parses only bounded preview fields from oversized streaming arguments', () => {
    const oversized = `{"command":"echo ok","description":"${'x'.repeat(
      STREAMING_ARGS_PREVIEW_MAX_CHARS + 100,
    )}"}`;

    expect(parseStreamingArgs(oversized)).toEqual({ command: 'echo ok' });
  });
});

describe('error payload formatting', () => {
  const filteredThinkOnlyMessage =
    'The API returned a response containing only thinking content without any text or tool calls. ' +
    'This usually indicates the stream was interrupted or the output token budget was exhausted ' +
    'during reasoning. Provider stop details: finishReason=filtered, rawFinishReason=content_filter. ' +
    'The provider filtered the response before visible output was emitted. Provider: example-provider, model: example-model';
  const conciseFilteredMessage =
    '[provider.api_error] Provider filtered the response before visible output ' +
    '(finishReason=filtered, rawFinishReason=content_filter).';

  it('shows concise provider filter text from structured error payload details', () => {
    const formatted = formatErrorPayload({
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: filteredThinkOnlyMessage,
      details: {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      },
    });

    expect(formatted).toBe(conciseFilteredMessage);
    expect(formatted).not.toContain('only thinking content');
    expect(formatted).not.toContain('token budget');
    expect(formatted).not.toContain('stream was interrupted');
  });

  it('shows concise provider filter text from KimiError details', () => {
    const error = new KimiError(ErrorCodes.PROVIDER_API_ERROR, filteredThinkOnlyMessage, {
      details: {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      },
    });

    expect(formatErrorMessage(error)).toBe(conciseFilteredMessage);
  });

  it('surfaces cause and diagnostic details without fabricating missing status or trace ids', () => {
    const formatted = formatErrorPayload({
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: 'The provider request ended without an observed outcome.',
      cause: {
        message: 'Anthropic error: antigravity_missing_terminal: Upstream completed without a usable answer.',
      },
      details: {
        errorSource: 'provider_event',
        upstreamErrorType: 'api_error',
        upstreamErrorCode: 'antigravity_missing_terminal',
        requestId: null,
        traceId: null,
        request_delivery: 'ambiguous',
      },
    });
    expect(formatted).toBe(
      '[provider.api_error] Anthropic error: antigravity_missing_terminal: Upstream completed without a usable answer. (The provider request ended without an observed outcome.) (type=api_error)',
    );
    expect(formatted).not.toContain('400');
  });

  it('prefers specific upstreamDetails.message on generic SSE transport errors while retaining outer transport state', () => {
    const formatted = formatErrorPayload({
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: 'Error: generic transport error',
      details: {
        errorSource: 'provider_event',
        upstreamErrorType: 'server_error',
        upstreamErrorCode: 'upstream_stream_reset',
        upstreamDetails: {
          message: 'Upstream worker stream aborted: backend connection reset by peer.',
        },
      },
    });
    expect(formatted).toBe(
      '[provider.api_error] upstream_stream_reset: Upstream worker stream aborted: backend connection reset by peer. (Error: generic transport error) (type=server_error)',
    );

    const longCode = `vendor_code_${'c'.repeat(210)}`;
    const prefixLength = 'Anthropic error: '.length + longCode.length + ': '.length;
    const fillerBefore296 = 'm'.repeat(296 - prefixLength);
    const emojiFormatted = formatErrorPayload({
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: 'Anthropic error: generic transport error',
      details: {
        errorSource: 'provider_stream',
        upstreamErrorType: 'api_error',
        upstreamDetails: {
          code: longCode,
          message: `${fillerBefore296}🛰🚀-tail-after-emoji-boundary`,
        },
      },
    });
    expect(emojiFormatted).toBe(
      `[provider.api_error] Anthropic error: ${longCode}: ${fillerBefore296}... (Anthropic error: generic transport error) (type=api_error)`,
    );
    expect(emojiFormatted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(emojiFormatted).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});
