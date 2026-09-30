import type { AcpElicitationRequest, AcpElicitationResponse } from '@kiki/acp-client';

import type { QuestionItem, QuestionResult } from '#/session/question/question';

interface Field {
  readonly key: string;
  readonly question: QuestionItem;
  readonly schema: Record<string, unknown>;
  readonly choices: readonly { label: string; value: string }[];
}

export function acpFormFields(request: AcpElicitationRequest): readonly Field[] | undefined {
  if (request.mode !== 'form') return undefined;
  const schema = object(request['requestedSchema']);
  const properties = object(schema?.['properties']);
  if (properties === undefined) return undefined;
  const fields: Field[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const property = object(raw);
    if (property === undefined) return undefined;
    const codex = object(object(property['_meta'])?.['codex']);
    if (codex?.['isSecret'] === true || codex?.['isOtherAnswer'] === true) return undefined;
    const type = property['type'];
    const choiceSchema = type === 'array' ? object(property['items']) : property;
    const choices = enumChoices(choiceSchema);
    if (type === 'boolean') choices.push({ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' });
    if (!['string', 'number', 'integer', 'boolean', 'array'].includes(String(type))) return undefined;
    if (type === 'array' && choices.length === 0) return undefined;
    if (new Set(choices.map((choice) => choice.label)).size !== choices.length) return undefined;
    if (type === 'array' && choices.some((choice) => choice.label.includes(', '))) return undefined;
    const title = typeof property['title'] === 'string' ? property['title'] : key;
    fields.push({ key, schema: property, choices, question: {
      question: title,
      body: typeof property['description'] === 'string' ? property['description'] : undefined,
      options: choices.map((choice) => ({ label: choice.label })),
      multiSelect: type === 'array',
      otherLabel: choices.length === 0 ? 'Enter a value' : undefined,
    } });
  }
  if (new Set(fields.map((field) => field.question.question)).size !== fields.length) return undefined;
  return fields;
}

export function acpFormResponse(
  request: AcpElicitationRequest, fields: readonly Field[], result: QuestionResult,
): AcpElicitationResponse {
  if (result === null || request.mode !== 'form') return { action: 'decline' };
  const answers = object('answers' in result && typeof result.answers === 'object' ? result.answers : result) ?? {};
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const field of fields) {
    const raw = answers[field.question.question];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return { action: 'decline' };
    const value = String(raw);
    const type = field.schema['type'];
    if (type === 'array') {
      const labels = value.split(', ');
      if (labels.some((label) => !field.choices.some((choice) => choice.label === label))) return { action: 'decline' };
      const selected = field.choices.filter((choice) => labels.includes(choice.label)).map((choice) => choice.value);
      if (!range(selected.length, field.schema['minItems'], field.schema['maxItems'])) return { action: 'decline' };
      content[field.key] = selected;
    } else if (type === 'boolean') {
      if (value !== 'Yes' && value !== 'No') return { action: 'decline' };
      content[field.key] = value === 'Yes';
    } else if (type === 'number' || type === 'integer') {
      const number = Number(value);
      if (value.trim().length === 0 || !Number.isFinite(number) || (type === 'integer' && !Number.isSafeInteger(number)) || !range(number, field.schema['minimum'], field.schema['maximum'])) return { action: 'decline' };
      content[field.key] = number;
    } else {
      const choice = field.choices.find((choice) => choice.label === value);
      if (field.choices.length > 0 && choice === undefined) return { action: 'decline' };
      const text = choice?.value ?? value;
      if (!range(text.length, field.schema['minLength'], field.schema['maxLength'])) return { action: 'decline' };
      content[field.key] = text;
    }
  }
  const schema = object(request['requestedSchema']);
  const required = schema?.['required'];
  if (Array.isArray(required) && required.some((key) => typeof key === 'string' && content[key] === undefined)) return { action: 'decline' };
  return { action: 'accept', content };
}

function range(value: number, minimum: unknown, maximum: unknown): boolean {
  return (typeof minimum !== 'number' || value >= minimum) && (typeof maximum !== 'number' || value <= maximum);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function enumChoices(schema: Record<string, unknown> | undefined): { label: string; value: string }[] {
  if (schema === undefined) return [];
  const variants = schema['oneOf'] ?? schema['anyOf'];
  if (Array.isArray(variants)) return variants.flatMap((raw) => {
    const item = object(raw);
    return typeof item?.['const'] === 'string' ? [{ value: item['const'], label: typeof item['title'] === 'string' ? item['title'] : item['const'] }] : [];
  });
  return Array.isArray(schema['enum']) ? schema['enum'].flatMap((value) => typeof value === 'string' ? [{ label: value, value }] : []) : [];
}
