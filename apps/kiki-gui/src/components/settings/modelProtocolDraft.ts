/**
 * The per-model request format, as a draft the editors can hold.
 *
 * A model either names its own wire format or follows its provider. The wire
 * keeps the two apart: `protocol` is what this model stores, `effective_protocol`
 * is what the server resolved after inheritance. The editors only ever write
 * the first, and they write "follow the provider" as an explicit `null` so a
 * stored override can actually be cleared. An unchanged choice sends nothing.
 *
 * The enum comes from the protocol schema itself. There is no second list
 * here, so a format the server adds shows up without touching this file
 * (it only needs a label).
 */

import {
  modelProtocolSchema,
  type CreateModelRequest,
  type CreateProviderRequest,
  type ModelProtocol,
  type PatchModelRequest,
} from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

/** `inherit` means "store nothing on the model, use the provider's format". */
export type ModelProtocolChoice = ModelProtocol | 'inherit';

export const MODEL_PROTOCOLS: readonly ModelProtocol[] = modelProtocolSchema.options;

/** Names people know from the vendors' own docs, not the internal ids. */
export const MODEL_PROTOCOL_LABEL: Readonly<Record<ModelProtocol, I18nKey>> = {
  openai: 'st.modelProtocol.openai',
  openai_responses: 'st.modelProtocol.openai_responses',
  anthropic: 'st.modelProtocol.anthropic',
  'google-genai': 'st.modelProtocol.google-genai',
};

/** The stored value as a choice. Absent means the model follows its provider. */
export function protocolChoiceFrom(stored: ModelProtocol | null | undefined): ModelProtocolChoice {
  return stored === undefined || stored === null ? 'inherit' : stored;
}

/**
 * The PATCH field for one model: omitted when the choice did not move, `null`
 * when it moved back to the provider, the format otherwise. Never `''`.
 */
export function protocolPatchField(
  draft: ModelProtocolChoice,
  baseline: ModelProtocolChoice,
): Pick<PatchModelRequest, 'protocol'> {
  if (draft === baseline) return {};
  return { protocol: draft === 'inherit' ? null : draft };
}

/** The create field: a new model that follows its provider stores nothing. */
export function protocolCreateField(choice: ModelProtocolChoice): Pick<CreateModelRequest, 'protocol'> {
  return choice === 'inherit' ? {} : { protocol: choice };
}

/**
 * Lays per-row choices onto a provider create body.
 *
 * `providerCreateBody` maps the draft's rows one to one and in order, so the
 * choices line up by index. A row without a choice follows the provider.
 */
export function withModelProtocols(
  body: CreateProviderRequest,
  choices: readonly ModelProtocolChoice[],
): CreateProviderRequest {
  if (body.models === undefined) return body;
  return {
    ...body,
    models: body.models.map((model, index) => {
      const choice = choices[index] ?? 'inherit';
      return choice === 'inherit' ? model : { ...model, protocol: choice };
    }),
  };
}

/** Keeps the per-row choices aligned with the rows after an add or remove. */
export function alignProtocolChoices(
  choices: readonly ModelProtocolChoice[] | undefined,
  length: number,
): ModelProtocolChoice[] {
  const next = (choices ?? []).slice(0, length);
  while (next.length < length) next.push('inherit');
  return next;
}
