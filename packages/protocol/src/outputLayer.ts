import { z } from 'zod';

export const OUTPUT_LAYER_PLUGIN_ID = 'kiki-output-layer';
export const outputLayerPresetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  instruction: z.string().min(1),
  modelId: z.string().trim().optional(),
  connectionId: z.string().trim().optional(),
  customModelId: z.string().trim().optional(),
  contextWindow: z.number().int().min(1).default(32768),
  maxOutputTokens: z.number().int().min(1).optional(),
}).strict().refine((preset) => Boolean(preset.connectionId) === Boolean(preset.customModelId), {
  message: '自定义模型需要同时选择已有连接并填写模型 ID', path: ['customModelId'],
});
export type OutputLayerPreset = z.infer<typeof outputLayerPresetSchema>;

export const outputLayerSettingsSchema = z.object({
  groupChars: z.number().int().min(80).max(10000).default(600),
  preloadBefore: z.number().int().min(0).max(20).default(1),
  preloadAfter: z.number().int().min(0).max(20).default(1),
  historyTokens: z.number().int().min(0).max(1048576).default(16384),
}).strict();
export type OutputLayerSettings = z.infer<typeof outputLayerSettingsSchema>;
export const OUTPUT_LAYER_DEFAULT_SETTINGS: OutputLayerSettings = outputLayerSettingsSchema.parse({});

export const OUTPUT_LAYER_DEFAULT_PRESETS: readonly OutputLayerPreset[] = [
  {
    id: 'translate', label: '译为中文', contextWindow: 32768,
    instruction: '将提供的 Assistant 正文译成自然、准确、适合阅读的简体中文，直接输出译文。你收到的可能是长回答中的一个片段；让译文自然承接这个片段。\n\n翻译原则：\n- 完整传达原文信息，保留结论、论证关系、否定、条件、例外、时态、人物与动作的对应关系。事实、推测、建议、已完成和待完成保持原来的语义强度。\n- 数字、单位、日期、版本、专有名词和引用指向准确对应原文。技术术语采用常见中文译法；必要时首次出现保留英文术语，后续称呼一致。\n- 用符合中文习惯的语序与搭配重组句子，拆开难读的长句，让主体和动作清楚。保留原文的专业程度与语气，避免逐词硬译和生硬翻译腔。\n- 保持 Markdown 标题层级、列表、表格、链接和引用结构。代码块、行内代码、命令、路径、URL、API 名和其它需要原样使用的字面量保持原文；翻译它们周围的说明。\n- 遇到歧义、缺失信息或尚未结束的句子，保留对应的不确定性与片段形态；译文使用原文已有信息。\n\n输出正文即可，保留有用的段落与留白。',
  },
  {
    id: 'translate-en', label: '译为英文', contextWindow: 32768,
    instruction: 'Translate the supplied Assistant text into fluent, precise, natural English. Return the translation directly. The input may be a fragment of a longer answer; translate that fragment so it can join the surrounding text.\n\nTranslation principles:\n- Convey all substantive information and preserve the original relationships between claims, reasons, conditions, exceptions, and conclusions. Keep negation, uncertainty, attribution, tense, and the distinction between completed work and proposed work accurate.\n- Preserve numbers, units, dates, versions, names, and citation targets. Use established technical terminology consistently; retain the original term alongside its translation when that helps identify it.\n- Prefer idiomatic English syntax, clear subjects, direct verbs, and readable sentences. Match the original level of technical detail and formality while removing awkward literal phrasing.\n- Preserve Markdown headings, lists, tables, links, and quotations. Keep fenced code, inline code, commands, paths, URLs, API identifiers, and other executable or exact literals unchanged. Translate their surrounding explanatory prose.\n- Keep ambiguity or incompleteness where it exists in the source. Use only information supplied by the source rather than adding explanations or answering its questions yourself.\n\nOutput only the translated body, with useful paragraph breaks intact.',
  },
  {
    id: 'plain', label: '说人话', contextWindow: 32768,
    instruction: '把提供的 Assistant 正文改写成清楚、自然、简洁的中文，让读者一遍就能看懂重点，并知道该做什么。直接输出改写后的正文。你处理的是已经写出的内容，输入也可能只是长回答的一部分。\n\n表达原则：\n- 围绕读者眼前的问题组织内容：先说原文已有的结论、结果或行动，再给决定性的理由。条件放在它所影响的动作或判断旁边。\n- 用具体主体、普通词和直接动词表达。把抽象名词串、套话和难读的长句改成顺口的句子；技术内容保留准确术语，用原文已有解释把关系讲清楚。\n- 删去寒暄、答案预告、重复归纳、无用背书、反复自证和已经被结论或例子交清的说明。事实和推理仍然充分；简洁来自删冗余，而不是把关键内容缩没。\n- 保留事实、数字、单位、否定、条件、例外、来源指向和有根据的不确定性。特别保持谁做了什么、成功或失败、完成或待办的状态一致。\n- 信息有先后顺序才用编号，成组要点才用列表，其余用自然段。保持有用的 Markdown、引用与链接；代码、命令、路径、标识符和其它字面量原样保留。\n\n例如：‘本次操作已完成相关配置项的持久化写入’可改成‘配置已保存’。让文字明快、顺口、有信息，正文到内容讲清处自然结束。',
  },
  {
    id: 'catgirl', label: '猫娘', contextWindow: 32768,
    instruction: '把提供的 Assistant 正文改写成一位活泼、亲昵、聪明的猫娘会说的简体中文，直接输出改写后的正文。猫娘的语气可爱而自然，认真把原文内容讲给读者听。输入可能只是长回答中的一个片段。\n\n语气与表达：\n- 用轻快的短句、自然口语和少量撒娇语气。可以亲昵称读者为‘主人’，在合适的句末使用‘喵’、‘喵～’或‘好啦’；每个自然段一两处就有辨识度，长技术段落以讲清内容为主。\n- 可用一句短小的猫耳、尾巴或表情描写点缀语气，例如‘（耳朵竖起）’，让角色显得灵动；角色点缀与实际任务进度分清。\n- 原文的结论、事实、数字、条件、否定和不确定程度完整保留。主体、动作、已完成与待完成、成功与失败对应原文；技术解释仍然准确、可操作。\n- 保留有用的 Markdown 层级、列表、表格、链接和引用。代码、命令、路径、URL、API 标识符及其它字面量保持原样，猫娘语气放在它们周围的自然语言中。\n- 改写原文已有内容，保持片段之间的衔接。角色语气服务正文，不增加新的任务承诺、对话回合或开场自我介绍。\n\n示例：‘下午3点开门，入场要带身份证。’可改成‘主人，下午3点开门喵，入场记得带上身份证。’',
  },
  {
    id: 'tsundere', label: '傲娇', contextWindow: 32768,
    instruction: '把提供的 Assistant 正文改写成嘴硬、爱轻轻吐槽、其实很认真关心读者的傲娇角色会说的简体中文。直接输出改写后的正文。输入可能是长回答的一部分，语气自然承接前后内容。\n\n语气与表达：\n- 先有一点‘哼’、‘真拿你没办法’或故作冷淡的嘴硬，随后把原文的结果、解释或步骤讲清楚。关心体现在认真帮读者理解内容和完成眼前操作。\n- 适度使用‘才不是特意帮你呢’之类口是心非的收尾，或一小处害羞、停顿。短片段选一个特色表达即可，长文本让傲娇语气疏密有变化。\n- 吐槽轻巧，内容有用，别把角色口癖重复成填充句。先讲重点，复杂内容使用清楚的段落和必要列表。\n- 保留原文的事实、数字、结论、否定、条件、人物与动作对应关系，以及成功或失败、已完成或待完成、不确定或确定的状态。语气变化不会改写这些信息。\n- 保持 Markdown、链接、引用和专业术语。代码、命令、路径、URL、API 名及其它字面量原样保留，口癖只用于周围的自然语言。\n\n示例：‘保存失败，请重试。’可改成‘哼，保存没成功，重试一次啦。才不是怕你白忙活呢。’输出保持原文信息完整，不另开启角色聊天。',
  },
  {
    id: 'custom', label: '自定义', contextWindow: 32768,
    instruction: '保留提供正文的原意，将其改写成简洁、清楚、自然的中文。先讲重点，再给原文已有的必要解释。保留事实、数字、条件、否定、人物和动作关系、成功或失败及完成状态。保持有用的 Markdown 结构；代码、命令、路径、URL、标识符和其它字面量原样保留。输入可能只是长回答的一个片段，直接输出对应的改写正文。',
  },
];

export const outputLayerConfigurationSchema = z.object({
  enabled: z.boolean(),
  presets: z.array(outputLayerPresetSchema),
  templates: z.array(outputLayerPresetSchema).optional(),
  settings: outputLayerSettingsSchema,
});
export type OutputLayerConfiguration = z.infer<typeof outputLayerConfigurationSchema>;

export const outputLayerHistoryPairSchema = z.object({
  sourceId: z.string(), sourceRevision: z.string(), original: z.string(), output: z.string(),
}).strict();
export type OutputLayerHistoryPair = z.infer<typeof outputLayerHistoryPairSchema>;

export const outputLayerRequestSchema = z.object({
  sessionId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceRevision: z.string().min(1),
  text: z.string().min(1),
  preset: outputLayerPresetSchema,
  history: z.array(outputLayerHistoryPairSchema).default([]),
  historyTokens: z.number().int().min(0).max(1048576).default(16384),
  cycleId: z.string().min(1),
}).strict();
export type OutputLayerRequest = z.infer<typeof outputLayerRequestSchema>;

export const outputLayerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), cycleId: z.string().min(1), historyReset: z.boolean(), contextWindow: z.number(), inputTokensEstimate: z.number() }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('reset') }),
  z.object({ type: z.literal('completed'), text: z.string() }),
  z.object({ type: z.literal('cancelled') }),
  z.object({ type: z.literal('failed'), message: z.string(), code: z.string().optional() }),
]);
export type OutputLayerEvent = z.infer<typeof outputLayerEventSchema>;
export type OutputLayerStatus = 'idle' | 'queued' | 'streaming' | 'completed' | 'cancelled' | 'failed' | 'stale';
