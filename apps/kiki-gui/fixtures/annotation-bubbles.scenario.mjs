import {
  assistantMsg,
  sessionRecord,
  userMsg,
} from './helpers.mjs';

const SID = 'session_fixture_annotation_bubbles';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: annotation bubbles' })],
  snapshots: {
    [SID]: {
      messages: [
        assistantMsg(
          SID,
          [
            'This message contains various passages for annotations.',
          ],
          15,
        ),
        // 1 annotation:
        userMsg(
          SID,
          '> passage one\n\nComment: 重点关注性能\n\n这是只有 1 条标注的消息。',
          12,
        ),
        // 3 annotations:
        userMsg(
          SID,
          '> item one\n\nComment: 第一点很关键\n\n> item two\n\nComment: 第二点需要排查\n\n> item three\n\nComment: 第三点待讨论\n\n这是恰好 3 条标注的消息，应该逐个展示气泡。',
          8,
        ),
        // 6+ annotations (e.g. 6 annotations):
        userMsg(
          SID,
          '> a1\n\nComment: 批注一\n\n> a2\n\nComment: 批注二\n\n> a3\n\nComment: 批注三\n\n> a4\n\nComment: 批注四\n\n> a5\n\nComment: 批注五\n\n> a6\n\nComment: 批注六\n\n这是超过 3 条（共 6 条）标注的消息，应该合并为汇总气泡。',
          4,
        ),
      ],
      has_more: false,
    },
  },
};
