export function sessionHistoryBudgetRecords(turns = 45): Record<string, unknown>[] {
  const fields = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`${index}-${'k'.repeat(900)}`, Object.fromEntries(Array.from({ length: 8 }, (_, child) => [`${child}-${'v'.repeat(900)}`, `exact ${index}/${child} 汉😀`.repeat(150)]))]));
  return Array.from({ length: turns }, (_, turnId) => [
    { type: 'turn.prompt', turnId, promptId: `prompt-${turnId}`, input: [{ type: 'text', text: `FIRST-MIDDLE-LAST ${turnId}` }], origin: { kind: 'user' }, time: 1000 + turnId },
    { type: 'context.append_loop_event', event: { type: 'step.begin', turnId, step: 1, uuid: `step-${turnId}` } },
    { type: 'context.append_loop_event', event: { type: 'tool.call', turnId, stepUuid: `step-${turnId}`, toolCallId: `call-${turnId}`, name: 'Example', args: turnId === Math.floor(turns / 2) ? fields : { target: turnId } } },
    { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: `call-${turnId}`, result: { output: `HEAD-${turnId}\n${'汉😀 middle '.repeat(3000)}\nTAIL-${turnId}`, isError: false } } },
    { type: 'context.append_loop_event', event: { type: 'step.end', turnId, step: 1, uuid: `step-${turnId}` } },
    { type: 'turn.ended', turnId, reason: 'completed', time: 2000 + turnId },
  ]).flat();
}
