import type { Locale } from '@kiki/session-core/i18n';

const PROFILE_INVITE: Record<Locale, string> = {
  en: 'After the setup check, offer two optional example subagent profiles, one at a time: implementer owns an engineering task through verification and handoff; reviewer independently checks a decision or candidate as a read-only leaf. Ask whether I want implementer in <KIKI_HOME>/agents/implementer.md, then separately whether I want reviewer in <KIKI_HOME>/agents/reviewer.md (default KIKI_HOME: ~/.kiki). Neither is installed automatically. Only after I agree to each specific profile, load the built-in kiki-profile skill for its complete embedded template and create that file on the Kiki server host. Copy the template with model_alias: inherit unchanged, so the role follows the model used by its parent at dispatch time. Tell me I can change it to a fixed model in Settings. Check for an existing file first; never overwrite one without asking. Verify each created profile loads.',
  zh: '完成配置检查后，请逐个询问我要不要创建两个可选的示例 subagent profile：implementer 负责工程任务直至验证和交付；reviewer 作为只读叶子角色独立审查方案或实际成果。先问我要不要在 <KIKI_HOME>/agents/implementer.md 创建 implementer，再单独问我要不要在 <KIKI_HOME>/agents/reviewer.md 创建 reviewer（KIKI_HOME 默认是 ~/.kiki）。不要自动安装任何一个。只有我对某个角色明确同意后，才加载内置 kiki-profile skill 获取对应的完整模板，在 Kiki 服务器主机创建该文件；保留示例中的 model_alias: inherit，不要改写；创建后的角色会跟随父 Agent 派发时使用的模型。告诉我“示例已设为 inherit，可在设置中改为固定模型”。先检查目标文件是否已存在；未经再次确认不得覆盖。验证创建的 profile 已被加载。',
};

export function onboardingWelcomeDraft(locale: Locale, setupDraft: string): string {
  return `${setupDraft}\n\n${PROFILE_INVITE[locale]}`;
}
