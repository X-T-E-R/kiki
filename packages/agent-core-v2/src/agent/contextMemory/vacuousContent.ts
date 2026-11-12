import { isVacuousContentPart, type ContentPart } from '#/kosong/contract/message';

export { isVacuousContentPart };

export function isSubstantiveContentPart(part: ContentPart): boolean {
  return part.type !== 'think' && !isVacuousContentPart(part);
}
