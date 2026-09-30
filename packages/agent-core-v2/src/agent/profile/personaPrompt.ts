import type { PersonaSnapshot } from '@kiki/agent-profiles/personaFile';

import { applyOverlay } from '#/agent/cognition/cognitionFiles';
import { estimateTokens, truncateTextToTokens } from '#/kosong/contract/tokens';

export const PERSONA_EXAMPLES_MAX_TOKENS = 1_500;
export const PERSONA_PROMPT_MARKER = '__KIKI_PERSONA_SLOT__';
export const PERSONA_CAPABILITY_NOTICE = '你运行在 Kiki 中，可以使用下面描述的工具和工作方式。';

export function renderPersonaBlock(snapshot: PersonaSnapshot): string {
  const { definition } = snapshot;
  const title = definition.title === undefined ? '' : ` title="${escapeAttribute(definition.title)}"`;
  const examples = renderExamples(snapshot.examples);
  return `<persona name="${escapeAttribute(definition.name)}"${title}>\n${definition.description}\n</persona>\n${PERSONA_CAPABILITY_NOTICE}${examples}`;
}

export function personaExamplesWereTruncated(snapshot: PersonaSnapshot): boolean {
  return snapshot.examples !== undefined && estimateTokens(snapshot.examples) > PERSONA_EXAMPLES_MAX_TOKENS;
}

export function hasDefaultIdentityParagraph(base: string): boolean {
  return /(?:^|\n\n)You are\b[\s\S]*?(?:\n\n|$)/i.test(base);
}

export function applyPersonaPrompt(
  base: string,
  block: string | undefined,
  roomPrompt?: string,
  marker = PERSONA_PROMPT_MARKER,
): string {
  const room = roomPrompt?.trim();
  if (block === undefined || block.length === 0) return applyRoomPrompt(base.replaceAll(marker, ''), roomPrompt);
  const combined = room === undefined || room.length === 0
    ? block
    : block.includes('</persona>')
      ? block.replace('</persona>', `</persona>\n\n${room}`)
      : `${block}\n\n${room}`;
  if (base.includes(marker)) return base.replace(marker, combined);
  return applyOverlay(base, combined, 'persona');
}

export function applyRoomPrompt(base: string, roomPrompt: string | undefined): string {
  const room = roomPrompt?.trim();
  return room === undefined || room.length === 0 ? base : applyOverlay(base, room, 'prepend');
}

function renderExamples(examples: string | undefined): string {
  if (examples === undefined || examples.trim().length === 0) return '';
  const text = truncateTextToTokens(examples, PERSONA_EXAMPLES_MAX_TOKENS);
  return `\n\n<examples>\n${text}\n</examples>`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return character;
    }
  });
}
