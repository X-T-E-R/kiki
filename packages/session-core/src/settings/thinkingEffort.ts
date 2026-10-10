const THINKING_EFFORT_DISPLAY_RANK = new Map([
  ['off', 0], ['none', 0], ['minimal', 1], ['low', 2],
  ['medium', 3], ['high', 4], ['xhigh', 5], ['max', 6],
]);

/** Sort known intensity slots for display without moving modes or vendor values. */
export function sortThinkingEffortsForDisplay(efforts: readonly string[]): string[] {
  const ranked = efforts.filter((effort) => THINKING_EFFORT_DISPLAY_RANK.has(effort))
    .toSorted((a, b) => THINKING_EFFORT_DISPLAY_RANK.get(a)! - THINKING_EFFORT_DISPLAY_RANK.get(b)!);
  let index = 0;
  return efforts.map((effort) => THINKING_EFFORT_DISPLAY_RANK.has(effort) ? ranked[index++]! : effort);
}
