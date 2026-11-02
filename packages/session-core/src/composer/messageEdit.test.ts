import { describe, expect, it } from 'vitest';
import { projectPresentedText, type TextPresentation } from '@kiki/transcript';
import { reconcileEditedThreadRefs } from './messageEdit';
import { prepareThreadRefContext } from './threadRefs';
import { parseSelectionCarryovers } from './timelineAnnotations';
import { selectionCarryoverPresentation } from './selectionQuote';

const first = '<thread_ref id="session_first" host_id="original-host" workspace_id="original-workspace" title="Original title" status="idle"/>';
const second = '<thread_ref id="session_second" host_id="second-host" title="Second title" status="running"/>';
const guidance = 'Original tool guidance, preserved verbatim.';
const context = `\n\n<thread_refs>\n${first}\n${second}\n${guidance}\n</thread_refs>`;
const body = 'compare /s/session_first and /s/session_second';
function message(text = body, payload = context) {
  return JSON.parse(JSON.stringify({ text: text + payload, presentation: { spans: [{ start: text.length, end: text.length + payload.length, kind: 'context' }] } })) as { text: string; presentation: TextPresentation };
}
const prepare = (text: string) => prepareThreadRefContext(text, (sessionId) => ({ sessionId, hostId: 'local', status: 'unknown' }));

describe('reconcileEditedThreadRefs', () => {
  it.each([body, `edited prose: ${body}`])('retains the full serialized hidden payload when only prose changes: %s', (editedBody) => {
    const original = message();
    const edited = reconcileEditedThreadRefs(original, prepare(editedBody));
    expect(edited.text).toBe(editedBody + context);
    expect(edited.presentation?.spans).toEqual([{ start: editedBody.length, end: edited.text.length, kind: 'context' }]);
    expect(projectPresentedText(edited.text, edited.presentation)).toBe(editedBody);
  });

  it('removes only the deleted entry, retaining the other tag and original guidance', () => {
    const editedBody = 'compare /s/session_second';
    const edited = reconcileEditedThreadRefs(message(), prepare(editedBody));
    expect(edited.text).toBe(editedBody + context.replace(`${first}\n`, ''));
  });

  it('rebuilds only a changed raw link, even if its canonical id is unchanged', () => {
    const editedBody = 'compare /s/session_first?turn=new and /s/session_second';
    const freshTag = '<thread_ref id="session_first" host_id="local" status="unknown"/>';
    const edited = reconcileEditedThreadRefs(message(), prepare(editedBody));
    expect(edited.text).toBe(editedBody + context.replace(first, freshTag));
  });

  it('drops an old target and appends a new target without downgrading the surviving one', () => {
    const editedBody = 'compare /s/session_first and /s/session_new';
    const freshTag = '<thread_ref id="session_new" host_id="local" status="unknown"/>';
    const edited = reconcileEditedThreadRefs(message(), prepare(editedBody));
    expect(edited.text).toBe(editedBody + context.replace(`${second}\n`, `${freshTag}\n`));
  });

  it('drops all generated context after the last reference is removed', () => {
    expect(reconcileEditedThreadRefs(message(), prepare('only prose'))).toEqual({ text: 'only prose' });
  });

  it('does not treat unmarked user-authored tags as retained generated context', () => {
    const edited = prepare('new /s/session_first');
    expect(reconcileEditedThreadRefs({ text: body + context }, edited)).toBe(edited);
  });

  it('preserves room payloads and selections with their source anchors through JSON', () => {
    const selections = [
      { quote: 'A', comment: '', source: { blockId: 'source-a', version: 'v1', start: 0, end: 1, text: 'A' } },
      { quote: 'B', comment: 'comment B', source: { blockId: 'source-b', version: 'v2', start: 0, end: 1, text: 'B' } },
      { quote: 'C', comment: '', source: null },
    ];
    const carry = selectionCarryoverPresentation(selections, []);
    const roomBody = 'visit /rooms/example-room';
    const roomContext = '\n\n<thread_refs>\n<room_ref id="example-room" workspace_id="original-workspace" name="Original room"/>\nOriginal guidance\n</thread_refs>';
    const original = message(carry.prefix + roomBody, roomContext);
    original.presentation.spans.unshift(...carry.presentation.spans);
    const edited = reconcileEditedThreadRefs(original, prepareThreadRefContext(roomBody, (sessionId) => ({ sessionId, status: 'unknown' }), (id) => ({ id, name: 'Changed room' })));
    const serialized = JSON.parse(JSON.stringify({ text: carry.prefix + edited.text, presentation: { spans: [...carry.presentation.spans, ...edited.presentation!.spans.map((span) => ({ ...span, start: span.start + carry.prefix.length, end: span.end + carry.prefix.length }))] } }));
    expect(parseSelectionCarryovers(serialized.text, serialized.presentation)).toMatchObject({ selections, body: roomBody });
    expect(edited.text).toBe(roomBody + roomContext);
  });
});
