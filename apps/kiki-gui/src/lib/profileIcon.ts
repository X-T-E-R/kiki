import { isNativeExecutor } from '@kiki/session-core/composer';

import type { IconName } from '../components/icons';

export interface ProfileIconInput {
  readonly profile?: string;
  readonly executor?: string;
  readonly main?: boolean;
  readonly hasFile?: boolean;
  readonly description?: string;
}

const EXTERNAL_HARNESS_PREFIXES = ['codex', 'claude', 'grok', 'agy', 'cursor', 'acp'] as const;

function isExternalHarnessToken(token: string): boolean {
  return EXTERNAL_HARNESS_PREFIXES.some(
    (prefix) => token === prefix || token.startsWith(`${prefix}-`) || token.startsWith(`${prefix}_`),
  );
}

function matchProfileArchetype(rawName: string): IconName | undefined {
  if (rawName === '') return undefined;
  const tokens = rawName.split(/[^a-z0-9]+/).filter((part) => part !== '');
  const has = (...words: readonly string[]) => words.some((w) => rawName === w || tokens.includes(w));
  const startsWith = (...prefixes: readonly string[]) => prefixes.some((p) => rawName.startsWith(p));

  if (has('explore', 'explorer', 'scout', 'locator') || startsWith('explore-', 'explore_')) {
    return 'compass';
  }
  if (
    has('implementer', 'implement', 'coder', 'engineer', 'coding', 'builder', 'dev')
    || startsWith('implementer-', 'implementer_')
  ) {
    return 'profileCode';
  }
  if (has('frontend', 'ui', 'ux', 'visual', 'brief', 'design') || startsWith('frontend-', 'brief_')) {
    return 'profileFrontend';
  }
  if (has('researcher', 'research', 'scholar', 'analyst', 'investigator') || startsWith('research')) {
    return 'profileResearch';
  }
  if (has('reviewer', 'review', 'audit', 'auditor', 'verifier', 'critic', 'qa') || startsWith('review')) {
    return 'profileReview';
  }
  if (has('think', 'thinker', 'reason', 'reasoner', 'architect') || startsWith('think-')) {
    return 'profileThink';
  }
  if (has('operator', 'browser', 'phone', 'cua', 'desktop', 'mobile') || startsWith('operator-')) {
    return 'profileOperator';
  }
  if (has('writer', 'writing', 'author', 'editorial', 'copywriter', 'story') || startsWith('writer-')) {
    return 'profileWriter';
  }
  if (has('director', 'cinema', 'studio', 'video', 'audio', 'media') || startsWith('director-')) {
    return 'profileDirector';
  }
  if (has('worker', 'batch', 'runner') || startsWith('worker-')) {
    return 'profileWorker';
  }
  if (isExternalHarnessToken(rawName)) {
    return 'terminal';
  }
  if (rawName === 'kiki' || rawName === 'main' || rawName === 'agent' || rawName === 'default') {
    return 'profileMain';
  }
  return undefined;
}

function matchDescriptionArchetype(description: string | undefined): IconName | undefined {
  if (description === undefined || description.trim() === '') return undefined;
  const text = description.toLowerCase();
  if (/\b(ui|frontend|visual|layout|css|react)\b|前端|界面|视觉/.test(text)) return 'profileFrontend';
  if (/\b(review|audit|verify|critique)\b|审查|评审|复核/.test(text)) return 'profileReview';
  if (/\b(research|literature|paper|survey|synthesis)\b|研究|调研|文献/.test(text)) return 'profileResearch';
  if (/\b(explore|locate|search|find files)\b|检索|定位|摸底/.test(text)) return 'compass';
  if (/\b(browser|phone|cua|operate|automation)\b|浏览器|真机|手机|操作/.test(text)) return 'profileOperator';
  if (/\b(write|writing|prose|article|editorial|story)\b|写作|文案|长文|故事/.test(text)) return 'profileWriter';
  if (/\b(director|video|audio|drama|film)\b|导演|视听|广播剧|分镜/.test(text)) return 'profileDirector';
  if (/\b(architecture|root-cause|reasoning)\b|推理|架构攻坚/.test(text)) return 'profileThink';
  if (/\b(implement|code|refactor|engineering|build)\b|工程|实现|编码/.test(text)) return 'profileCode';
  return undefined;
}

/**
 * Resolve a semantic 16x16 monochrome icon for an execution profile or agent.
 * Personas keep `PersonaAvatar` at their own call sites; this helper strictly
 * represents execution profiles, engines, and subagent roles.
 */
export function resolveProfileIcon(input: ProfileIconInput): IconName {
  const external = input.executor !== undefined
    && input.executor.trim() !== ''
    && !isNativeExecutor(input.executor);
  const rawName = (input.profile ?? '').trim().toLowerCase();

  if (rawName === '') {
    if (external) return 'terminal';
    if (input.hasFile === true) return 'file';
    return input.main === false ? 'agent' : 'profileMain';
  }

  const byName = matchProfileArchetype(rawName);
  if (byName !== undefined) {
    if (byName === 'profileMain' && external) return 'terminal';
    return byName;
  }

  const byDescription = matchDescriptionArchetype(input.description);
  if (byDescription !== undefined) return byDescription;

  if (external) return 'terminal';
  if (input.hasFile === true) return 'file';
  return input.main === true ? 'profileMain' : 'agent';
}
