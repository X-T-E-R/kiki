import type { Locale } from '../i18n';

const COPY = {
  unavailable: ['Preview unavailable', '预览暂不可用'],
  source: ['Source', '来源'],
  contentType: ['Content type', '内容类型'],
  warnings: ['Warnings', '警告'],
  notLoaded: ['Result not provided or not yet loaded', '结果未提供或尚未加载'],
  status: ['Status', '状态'],
  job: ['Job', '作业'],
  action: ['Action', '动作'],
  queued: ['Queued', '已排队'],
  succeeded: ['Succeeded', '已成功'],
  empty: ['Empty', '为空'],
  partial: ['Partial', '部分完成'],
  get: ['Check job', '查看作业'],
  read: ['Read job result', '读取作业结果'],
  cancel: ['Cancel job', '取消作业'],
  cancelRequested: ['Cancellation requested', '已请求取消'],
  yes: ['Yes', '是'],
  no: ['No', '否'],
  artifact: ['Result artifact', '结果载荷'],
  chunks: ['Loaded chunks', '已载入分块'],
  poll: ['Poll after (ms)', '下次查询间隔（毫秒）'],
  schema: ['Schema', '数据格式'],
  notesCleared: ['Cleared', '已清除'],
} as const;

export function toolRecordCopy(key: keyof typeof COPY, locale: Locale = 'en'): string {
  return COPY[key][locale === 'zh' ? 1 : 0];
}
