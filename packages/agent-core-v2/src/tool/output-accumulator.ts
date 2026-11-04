import { sliceUtf16 } from '#/_base/text/utf16';
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS,
  type ExecutableToolErrorResult,
  type ExecutableToolSuccessResult,
  type ToolResultSpill,
} from './toolContract';

export type ToolOutputAccumulatorResult = (
  | ExecutableToolErrorResult
  | ExecutableToolSuccessResult
) & {
  readonly output: string;
  readonly brief?: string;
};

export class ToolOutputAccumulator {
  private readonly buffer: string[] = [];
  private retainedChars = 0;
  private totalCharsValue = 0;

  get nChars(): number {
    return this.retainedChars;
  }

  get totalChars(): number {
    return this.totalCharsValue;
  }

  write(text: string): void {
    const remainingRetention = DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS - this.totalCharsValue;
    this.totalCharsValue += text.length;
    if (remainingRetention <= 0) return;
    let kept = sliceUtf16(text, 0, remainingRetention);
    if (kept.length === remainingRetention) kept = kept.replace(/[\uD800-\uDBFF]$/, '');
    this.buffer.push(kept);
    this.retainedChars += kept.length;
  }

  ok(message = '', options: { readonly brief?: string } = {}): ToolOutputAccumulatorResult {
    let finalMessage = message;
    if (finalMessage.length > 0 && !finalMessage.endsWith('.')) {
      finalMessage += '.';
    }
    const output = this.buffer.join('');
    return {
      isError: false,
      output: output.length === 0 ? finalMessage : output,
      brief: options.brief,
      spill: this.completionSpill(finalMessage),
    };
  }

  error(
    message: string,
    options: { readonly brief?: string } = {},
  ): ToolOutputAccumulatorResult {
    const output = this.buffer.join('');
    return {
      isError: true,
      output:
        message.length === 0
          ? output
          : output.length === 0
            ? message
            : output.endsWith('\n')
              ? `${output}${message}`
              : `${output}\n${message}`,
      brief: options.brief,
      spill: this.retentionSpill(message),
    };
  }

  private retentionSpill(suffix?: string): ToolResultSpill | undefined {
    if (this.totalCharsValue <= this.retainedChars) return undefined;
    return {
      totalChars: this.totalCharsValue,
      suffix: suffix !== undefined && suffix.length > 0 ? suffix : undefined,
    };
  }

  private completionSpill(suffix: string): ToolResultSpill | undefined {
    const retentionSpill = this.retentionSpill();
    if (retentionSpill !== undefined) {
      return suffix.length > 0 ? { ...retentionSpill, suffix } : retentionSpill;
    }
    if (suffix.length === 0 || this.totalCharsValue <= DEFAULT_TOOL_RESULT_MAX_CHARS) {
      return undefined;
    }
    return { suffix };
  }
}
