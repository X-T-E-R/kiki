/**
 * Server-code / zod-issue → i18n mapping for `errorText` (locale.ts).
 *
 * An envelope failure arrives as an ApiError-shaped object (`{ code, msg }`)
 * whose message text carries a trailing ` (code NNNNN)`, and a klient REST
 * schema drift arrives as a thrown ZodError (`name: 'ZodError'` with an
 * `issues` array) — session-core does not depend on zod, so both are detected
 * structurally. A known code gets short localized copy; an unmapped shape
 * falls through to the raw message.
 */

import { ErrorCodeReason } from '@kiki/protocol';

import type { I18nKey } from './locale';

/** Protocol `*.not_found` reasons name their object in the noun before the dot. */
const NOT_FOUND_NOUNS: Readonly<Record<string, I18nKey>> = {
  session: 'err.notFound.session',
  prompt: 'err.notFound.prompt',
  message: 'err.notFound.message',
  approval: 'err.notFound.approval',
  question: 'err.notFound.question',
  task: 'err.notFound.task',
  file: 'err.notFound.file',
  workspace: 'err.notFound.workspace',
  model: 'err.notFound.model',
  skill: 'err.notFound.skill',
  plugin: 'err.notFound.plugin',
  persona: 'err.notFound.persona',
  memory: 'err.notFound.memory',
};

/** Codes whose localized copy does not follow the not-found pattern. */
const SPECIFIC_CODE_KEYS: Readonly<Record<number, I18nKey>> = {
  40001: 'err.serverData',
  40002: 'err.serverData',
  40111: 'err.authMissing',
  40112: 'err.authRevoked',
  40113: 'err.modelUnresolved',
  40426: 'err.identityMissing',
  40411: 'err.fsDenied',
  40412: 'err.providerMissing',
  40424: 'err.sshHostMissing',
  40427: 'err.spacePresetMissing',
  40901: 'err.sessionBusy',
  40933: 'err.sessionLocked',
  40939: 'err.indexBuilding',
  41301: 'err.fileTooLarge',
  42901: 'err.rateLimited',
  42904: 'err.dispatchLimited',
  50004: 'err.catalogUnavailable',
  60001: 'err.toolFailed',
};

const CODE_SUFFIX = /\s*\(code (-?\d+)\)\s*$/;
const ZOD_ISSUE_SHAPE = /"code"\s*:\s*"(invalid_type|too_small|too_big|invalid_enum_value|unrecognized_keys?)"/;

const hasCode = (value: unknown): value is { code: number } =>
  typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'number';

const looksLikeZodError = (value: unknown): boolean =>
  typeof value === 'object' && value !== null &&
  (value as { name?: unknown }).name === 'ZodError' &&
  Array.isArray((value as { issues?: unknown }).issues);

/**
 * The dictionary key a caught error maps to, or `undefined` when the raw
 * message is the most honest thing to show. Zod issue arrays never reach the
 * screen as JSON; a validation failure with a known field names the field.
 */
export function mappedErrorKey(error: unknown, rawText: string): I18nKey | undefined {
  if (hasCode(error)) {
    const specific = SPECIFIC_CODE_KEYS[error.code];
    if (specific !== undefined) return specific;
    const reason = (ErrorCodeReason as Record<number, string | undefined>)[error.code];
    if (reason?.endsWith('.not_found') === true) {
      const noun = NOT_FOUND_NOUNS[reason.slice(0, -'.not_found'.length)];
      return noun ?? 'err.notFound.generic';
    }
  }
  // The code is usually on the error object; older producers leave it only in
  // the formatted message, so the text gets one more look.
  const suffixed = CODE_SUFFIX.exec(rawText);
  if (suffixed !== null) {
    const specific = SPECIFIC_CODE_KEYS[Number(suffixed[1])];
    if (specific !== undefined) return specific;
  }
  if (looksLikeZodError(error)) {
    const issues = (error as { issues: readonly { path?: readonly unknown[] }[] }).issues;
    const top = issues[0]?.path?.[0];
    return top === 'advisor_status' ? 'err.memoryAdvisorData' : 'err.serverData';
  }
  if (ZOD_ISSUE_SHAPE.test(rawText)) return rawText.includes('advisor_status') ? 'err.memoryAdvisorData' : 'err.serverData';
  return undefined;
}
