import boundedContent from './content-continuation.scenario.mjs';

export const USER_TAIL_REF = { source: { kind: 'turn', id: '1' }, path: ['prompt'], revision: 'automatic-tail', kind: 'text', offset: 3, total: 9 };
const scenario = structuredClone(boundedContent);
const turn = scenario.snapshots.session_fixture_content_bounded.agent_transcripts.main.items[0];
turn.prompt = 'abc';
turn.steps = [];
turn.contentRefs = [USER_TAIL_REF];

export default scenario;
