import type { Component } from '@kiki/pi-tui';

/**
 * One empty row that returns the same array on every render. pi-tui's
 * `Spacer` builds a new array each time, which a parent that reuses its
 * output by child-array identity (`ToolCallComponent`) reads as a change, so
 * that parent never hit its cache and rebuilt every frame.
 */
export class BlankLine implements Component {
  private readonly lines = [''];

  invalidate(): void {}

  render(_width: number): string[] {
    return this.lines;
  }
}
