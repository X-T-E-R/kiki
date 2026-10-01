import type { Locale } from '../i18n';

const COPY = {
  unavailable: ['Preview unavailable', '预览暂不可用'],
  source: ['Source', '来源'],
  contentType: ['Content type', '内容类型'],
  completeness: ['Completeness', '完整性'],
  returned: ['Returned content; source completeness not verified', '已返回的正文；未核验来源是否完整'],
  payloadTruncated: ['Returned payload is truncated or incomplete; showing loaded content only', '返回载荷已截断或不完整；仅显示已载入内容'],
  warnings: ['Warnings', '警告'],
  warningCompleteness: ['Fetch warnings; completeness is not guaranteed', '抓取有警告；不保证内容完整'],
  displayOmitted: ['Display truncated; the rest is already loaded', '显示已截断；其余内容已载入'],
  showFull: ['Show full loaded text', '查看已载入全文'],
  collapse: ['Collapse text', '收起正文'],
  notLoaded: ['Result not provided or not yet loaded', '结果未提供或尚未加载'],
  loadedOnly: ['Copies the loaded record only', '仅复制已载入记录'],
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
  moreChunks: ['More chunks are not loaded', '还有分块尚未加载'],
  encodedChunks: ['Encoded result chunks, not a reconstructed full document', '编码结果分块，并非已还原的完整正文'],
  poll: ['Poll after (ms)', '下次查询间隔（毫秒）'],
  schema: ['Schema', '数据格式'],
} as const;

export function toolRecordCopy(key: keyof typeof COPY, locale: Locale = 'en'): string {
  return COPY[key][locale === 'zh' ? 1 : 0];
}
