import { useI18n as useBaseI18n } from '../../i18n';

export const channelsI18nDict = {
  en: {
    'st.im.channels': 'Channels',
    'st.im.addBinding': '+ Bind',
    'st.im.sendMessageTitle': 'Active Messaging Tool (SendMessage)',
    'st.im.toolBadge': 'Tool',
    'st.im.personaDefault': 'Default Persona',
    'st.im.sm.personaActive': 'Persona message mode active · default fanout {count} out',
    'st.im.sm.sessionActive': 'Session override active (hot-loaded) · fanout {count} out',
    'st.im.sm.defaultOff': 'Standard thread default off · enable to hot-load tool',
    'st.im.group.im': 'External IM channels (independent I/O switches)',
    'st.im.group.notify': 'Unidirectional notification channels (outbound only)',
    'st.im.dir.in': 'in',
    'st.im.dir.out': 'out',
    'st.im.dir.inOut': 'in · out',
    'st.im.tag.bi': 'bidirectional',
    'st.im.tag.in': 'in only',
    'st.im.tag.out': 'out only',
    'st.im.tag.off': 'off',
    'st.im.pill.in': 'in',
    'st.im.pill.out': 'out',
    'st.im.noBindings': 'No IM channels bound to this session.',
    'st.im.noNotify': 'No notification channels configured.',
    'st.im.unbind': 'Unbind',
    'st.im.internalAlwaysOn': 'In-session always visible',
    'st.im.borrowing': 'Channel borrowing',
    'st.im.settingsLink': 'Settings ↗',
    'st.im.picker.title': 'Bind input or output channel to this thread',
    'st.im.picker.close': 'Close',
    'st.im.picker.empty': 'No available channels found.',
    'st.im.rebindButton': 'Rebind…',
    'st.im.pendingReanchor': 'Reanchor required',
    'st.im.occupiedBy': 'Bound to',
    'st.im.unknownSession': 'Unknown session',
    'st.im.rebind.title': 'Rebind channel identity?',
    'st.im.rebind.confirm': 'Confirm and transfer',
    'st.im.rebind.cancel': 'Cancel',
    'st.im.rebind.description': 'The same inbound identity can belong to only one thread at a time. Once confirmed, subsequent messages, callbacks and replies will route to this session. Previous session history remains intact.',
    'st.im.rebind.variant': 'Channel variant',
    'st.im.rebind.identity': 'Identity key',
    'st.im.rebind.currentOwner': 'Current thread',
    'st.im.rebind.targetOwner': 'Target thread',
    'st.im.allowBorrowing': 'Allow borrowing unbound channels',
    'st.im.allowBorrowingHint': 'Allow SendMessage to explicitly target channels that are not bound to this session.',
  },
  zh: {
    'st.im.channels': '通信信道',
    'st.im.addBinding': '+ 绑定',
    'st.im.sendMessageTitle': '主动消息工具 (SendMessage)',
    'st.im.toolBadge': '工具',
    'st.im.personaDefault': '默认角色',
    'st.im.sm.personaActive': '角色消息模式已开启 · 默认扇出 {count} 出',
    'st.im.sm.sessionActive': '本会话已开启 (热加载) · 扇出 {count} 出',
    'st.im.sm.defaultOff': '普通线程默认关 · 开启后热加载工具',
    'st.im.group.im': '外部 IM 信道（输入 / 输出可独立开关）',
    'st.im.group.notify': '单向推送信道（仅出站）',
    'st.im.dir.in': '入',
    'st.im.dir.out': '出',
    'st.im.dir.inOut': '入 · 出',
    'st.im.tag.bi': '双向',
    'st.im.tag.in': '仅入',
    'st.im.tag.out': '仅出',
    'st.im.tag.off': '已停',
    'st.im.pill.in': '入',
    'st.im.pill.out': '出',
    'st.im.noBindings': '本会话尚未绑定任何外部 IM 信道',
    'st.im.noNotify': '暂无单向推送信道',
    'st.im.unbind': '解绑',
    'st.im.internalAlwaysOn': '会话内常驻可见',
    'st.im.borrowing': '跨信道借用',
    'st.im.settingsLink': '设置 ↗',
    'st.im.picker.title': '绑定输入或输出信道至本线程',
    'st.im.picker.close': '收起',
    'st.im.picker.empty': '没有可绑定的候选信道',
    'st.im.rebindButton': '转绑到此会话…',
    'st.im.pendingReanchor': '待确认归属',
    'st.im.occupiedBy': '已归属于',
    'st.im.unknownSession': '未知会话',
    'st.im.rebind.title': '转移信道变体归属？',
    'st.im.rebind.confirm': '确认转移并开启',
    'st.im.rebind.cancel': '取消',
    'st.im.rebind.description': '同一输入身份变体同一时刻仅归属一个会话。确认后，该变体的后续入站消息、交互回执与出站投递将转入当前会话；原会话中的历史消息保留不变。',
    'st.im.rebind.variant': '信道变体',
    'st.im.rebind.identity': '身份标识',
    'st.im.rebind.currentOwner': '当前归属',
    'st.im.rebind.targetOwner': '转入目标',
    'st.im.allowBorrowing': '允许借用未绑定信道发送',
    'st.im.allowBorrowingHint': '允许 SendMessage 显式指定投递未绑定到当前会话的全局可用信道。',
  },
} as const;

export function useChannelsI18n() {
  const { locale, t: baseT, tp, time, setLocale } = useBaseI18n();

  const t = (key: string, params?: Record<string, string | number>) => {
    const dict = (channelsI18nDict as Record<string, Record<string, string>>)[locale] || channelsI18nDict.en;
    const template = dict[key] || channelsI18nDict.en[key as keyof typeof channelsI18nDict.en] || baseT(key as any, params);
    if (!params) return template;
    return template.replaceAll(/\{(\w+)\}/g, (raw: string, name: string) => {
      const value = params[name];
      return value === undefined ? raw : String(value);
    });
  };

  return { locale, t, tp, time, setLocale };
}
