export interface DirectiveCues {
  readonly instructions?: readonly string[];
  readonly history?: readonly string[];
}

export const DEFAULT_DIRECTIVE_CUES = {
  instructions: ['以后', '不要', '别', '一律', '每次', '记住', '直接', '默认', '必须', '禁止', '改成', '纠正', '应该', '始终', '务必', '优先', '遵守', '下次', '统一', '再也',
    '只能', '最多', '上限', '不超过', '并发', '放开', '放宽', '收紧', '撤销', '取消', '恢复', '改回', '临时', '定了', '拍板',
    'always', 'never', "don't", 'do not', 'from now on', 'remember', 'default', 'must', 'instead', 'prefer', 'directly', 'pin', 'every time', 'make sure', 'stop', 'correction', 'use only', 'avoid', 'keep using', 'next time',
    'at most', 'limit', 'no more than', 'revert', 'revoke', 'relax', 'lift', 'temporary', 'decided'],
  history: ['之前', '早先', '上次', '我说过', '刚才说', '前面说', '以前说', 'as I said', 'earlier', 'again', 'last time', 'previously', 'already told'],
} as const;

export function matchesDirectiveCue(text: string, cues: readonly string[]): boolean {
  const normalized = text.toLocaleLowerCase();
  return cues.some((cue) => cue.trim().length > 0 && normalized.includes(cue.toLocaleLowerCase()));
}
