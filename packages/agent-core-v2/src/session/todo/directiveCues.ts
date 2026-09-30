export interface DirectiveCues {
  readonly instructions?: readonly string[];
  readonly history?: readonly string[];
}

export const DEFAULT_DIRECTIVE_CUES = {
  instructions: ['从现在开始', '以后', '不要', '别', '一律', '每次', '记住', '直接', '默认', '必须', '禁止', '改成', '纠正', '应该', '始终', '务必', '优先', '遵守', '下次', '统一', '再也',
    '只能', '最多', '上限', '不超过', '并发', '放开', '放宽', '收紧', '撤销', '取消', '恢复', '改回', '临时', '定了', '拍板',
    'always', 'never', "don't", 'do not', 'from now on', 'remember', 'default', 'must', 'instead', 'prefer', 'directly', 'pin', 'every time', 'make sure', 'stop', 'correction', 'use only', 'avoid', 'keep using', 'next time',
    'at most', 'limit', 'no more than', 'revert', 'revoke', 'relax', 'lift', 'temporary', 'decided'],
  history: ['之前', '早先', '上次', '我说过', '刚才说', '前面说', '以前说', '我定', '规矩', '还记得', 'as I said', 'earlier', 'again', 'last time', 'previously', 'already told', 'recall', 'remember'],
} as const;

export function matchesDirectiveCue(text: string, cues: readonly string[]): boolean {
  return cues.some((cue) => {
    const value = cue.trim().toLowerCase();
    if (!value) return false;
    if (!/[a-z]/i.test(value)) return text.includes(value);
    const escaped = value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, 'i').test(text);
  });
}

export interface DirectiveCandidate {
  readonly subject: string;
  readonly operation: 'set' | 'replace' | 'revoke' | 'correct';
  readonly value: string;
  readonly scope: 'agent' | 'configuration';
  readonly lifetime: 'persistent';
  readonly evidenceSpan: string;
  readonly replaces?: string;
}

function operativeText(text: string): string {
  return text.replaceAll(/```[\s\S]*?```/g, '').replaceAll(/^\s*>.*$/gm, '')
    .replaceAll(/[“「"]([^”」"\n]*)[”」"]/g, (quote: string, body: string) =>
      /(?:设为|作为|采用).*(?:默认|规则)|adopt.*(?:rule|default)/i.test(text) ? body : '')
    .replaceAll(/(?:^|[。！？\n])\s*(?:引用|举例|例如|比如|假设|for example|quoted|suppose)[：:]?[^。！？\n]*/gi, '')
    .replaceAll(/(?:不要记住|别记住|这不是我的要求|do not remember|don't remember)[^。！？\n]*/gi, '');
}

export function classifyDirectives(text: string, cues: DirectiveCues = {}): readonly DirectiveCandidate[] {
  const operative = operativeText(text);
  if (!matchesDirectiveCue(operative, cues.instructions ?? DEFAULT_DIRECTIVE_CUES.instructions)) return [];
  const candidates: DirectiveCandidate[] = [];
  for (const clause of operative.split(/[。！？\n;；]/).map((part) => part.trim()).filter(Boolean)) {
    const correction = /你怎么.*每次|别再|不要再|stop.*(?:reply|asking|ending)/i.test(clause);
    const change = /撤销|取消.*(?:限制|规则|上限)|放开|放宽|收紧|改回|恢复.*(?:限制|规则)|lift.*(?:cap|limit)|revoke|relax|revert/i.test(clause);
    if (!correction && !change && /应该怎么|怎么设计|如何设计|是否可以|能不能|可不可以|should (?:we|i)|how (?:should|would)|can (?:we|you).*\?/i.test(clause)) continue;
    if (/合并以后|完成以后|做完以后/.test(clause) && !/每次|一律|始终|以后(?:都|默认)/.test(clause)) continue;
    const configuration = /(?:配置|configure|configuration)/i.test(clause) && /模型|model|默认|统一/i.test(clause) && /帮我|请|用|设|use|set|configure/i.test(clause);
    const subject = /并发|concurren|\bcap\b/i.test(clause) ? 'delegation.concurrency'
      : /模型|\bmodels?\b|\bpin\b/i.test(clause) ? 'model.binding'
      : /回复|末尾|风格|reply|response|asking/i.test(clause) ? 'reply.style'
      : /提交信息|commit/i.test(clause) ? 'commit.format'
      : /(?:规则|规矩|限制|rule|limit)/i.test(clause) && change ? 'existing.rule'
      : /工具|权限|permission|\btools?\b/i.test(clause) ? 'tool.permission'
      : 'agent.behavior';
    if (!correction && !change && !configuration) {
      if (subject === 'agent.behavior') {
        if (/为什么|吗|呢|\?$/.test(clause)) continue;
        if (!/(?:从现在开始|(?:^|[，,:：])\s*以后|以后(?:都|不要|默认)|每次|一律|始终|下次)[^，,:：]{0,80}(?:用|写|放|设|遵守|保留|记录)|(?:只能|最多).+|^(?:别|不要|禁止)\s*\S|\b(?:always|never|must|don't|do not|from now on|every time|at most|no more than|use only|keep using)\s+\S/i.test(clause)) continue;
      } else {
        if (!/以后|每次|一律|默认|始终|只能|最多|上限|不超过|并发|定了|拍板|always|never|default|from now on|at most|no more than|use only|keep using|must/i.test(clause)) continue;
        if (!/不要|别|一律|只能|最多|上限|必须|用|设|定了|拍板|always|never|must|use|limit|pin/i.test(clause)) continue;
      }
    }
    const operation = /撤销|取消|不设.*上限|lift|revoke/i.test(clause) ? 'revoke'
      : change ? 'replace' : correction ? 'correct' : 'set';
    candidates.push({ subject, operation, value: clause, scope: configuration ? 'configuration' : 'agent',
      lifetime: 'persistent', evidenceSpan: clause, replaces: operation === 'set' ? undefined : subject });
  }
  return candidates;
}

export function historyReferenceTopic(text: string, cues: DirectiveCues = {}): string | undefined {
  const operative = operativeText(text);
  if (!matchesDirectiveCue(operative, cues.history ?? DEFAULT_DIRECTIVE_CUES.history)) return undefined;
  const artifact = /\b[a-z0-9][a-z0-9._-]*(?:design|proposal|report|plan)(?:\.md)?\b|\b[a-z0-9][a-z0-9._-]*\.md\b/i.exec(operative)?.[0];
  if (artifact !== undefined && /之前|早先|上次|前面|earlier|previous|last time/i.test(operative) &&
    /考虑|结合|参照|查|找|核对|review|combine|refer|check|find/i.test(operative)) return `artifact:${artifact.toLowerCase()}`;
  if (!/我(?:说|定)|你(?:说|答|记)|规矩|规则|限制|并发|决定|证据|对话|as I said|already told|(?:earlier|previous|last time).*(?:rule|decision|evidence|conversation|cap|limit)/i.test(operative)) return undefined;
  if (!/按(?:照)?[^。！？\n]*(?:规矩|规则|决定|要求)|符合|还记得|查|找|核对|说过|我定|纠正|放开|撤销|取消|what|check|recall|remember|said|told|lift|revoke/i.test(operative)) return undefined;
  return /并发|concurren|\bcap\b|sol|opus/i.test(operative) ? 'delegation.concurrency' : 'earlier.rule-or-evidence';
}
