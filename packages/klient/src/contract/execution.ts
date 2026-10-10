import { executionBindingSchema, executionSelectionSchema, type ExecutionBinding, type ExecutionSelection } from '@kiki/protocol';
import type { z } from 'zod';

type MutableWire<T> = T extends readonly (infer U)[] ? MutableWire<U>[] : T extends object ? { -readonly [K in keyof T]: MutableWire<T[K]> } : T;

function mutableSelection(value: ExecutionSelection): MutableWire<ExecutionSelection> {
  const overrides = value.overrides;
  return { ...value, overrides: overrides === undefined ? undefined : { ...overrides,
    kiki_context: overrides.kiki_context == null ? overrides.kiki_context : [...overrides.kiki_context] } };
}

export const executionSelectionWireSchema: z.ZodType<MutableWire<ExecutionSelection>, z.input<typeof executionSelectionSchema>> = executionSelectionSchema.transform(mutableSelection);
export const executionBindingWireSchema: z.ZodType<MutableWire<ExecutionBinding>, z.input<typeof executionBindingSchema>> = executionBindingSchema.transform((value): MutableWire<ExecutionBinding> => ({
  ...value, selection: mutableSelection(value.selection),
  effective: { ...value.effective, kiki_context: [...value.effective.kiki_context] },
}));
