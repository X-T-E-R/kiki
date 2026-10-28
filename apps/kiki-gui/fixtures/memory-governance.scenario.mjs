/**
 * memory-governance — /memory on the governed store.
 *
 * Global holds three facts that tell the governed views apart:
 *   - a deployment rule the user corrected once (5 workers, was 9), so the
 *     detail lists a correction on the current revision and an earlier one
 *     whose revision can be opened;
 *   - two entries learned from the same release note, so forgetting either
 *     previews both;
 *   - an ordinary entry with one source and no decisions.
 * A workspace scope holds one entry with a slow provenance read, so a scope
 * switch while it is in flight must not paint it on another object.
 *
 * Mock data for the contract kap-server serves: authority status, provenance,
 * revisions and forget follow routes/memory.ts field for field.
 */

import { createHash } from 'node:crypto';

import memory from './memory.scenario.mjs';
import { ts } from './helpers.mjs';

const WS_APP = 'wd_fixture_000000000000';

const revision = (entry) => createHash('sha256').update(JSON.stringify({
  title: entry.title, body: entry.body, type: entry.type, status: entry.status, pinned: entry.pinned,
  basis: entry.basis, validity: entry.validity, covered_by: entry.covered_by,
})).digest('hex');

const base = (fields) => ({ status: 'active', pinned: false, created: ts(9_000), updated: ts(90), source: { writer: 'user' }, reason: '', ...fields });

const original = base({
  id: 'm_deploy_workers', type: 'feedback', title: 'Deployment procedure',
  body: 'Use 9 workers for the nightly deploy; never upload build output.',
  reason: 'Owner instruction', updated: ts(9_000),
});
const corrected = { ...original, body: 'Use 5 workers for the nightly deploy; never upload build output.', reason: 'Owner lowered the worker count after the October incident', updated: ts(90) };
const releaseA = base({
  id: 'm_release_freeze', type: 'project', title: 'Release freeze starts two days before launch',
  body: 'No merges to the release branch in the final two days before a launch.', source: { writer: 'agent', session: 'session_fixture_memory', turn: 4 },
  basis: { kind: 'observed', note: 'From the release checklist shared in the planning session.', refs: ['docs/release-checklist.md#freeze'] }, updated: ts(400),
});
const releaseB = base({
  id: 'm_release_owner', type: 'project', title: 'Release notes are approved by the launch owner',
  body: 'The launch owner signs off release notes before they are published.', source: { writer: 'agent', session: 'session_fixture_memory', turn: 4 },
  basis: { kind: 'observed', note: 'Same release checklist.', refs: ['docs/release-checklist.md#notes'] }, updated: ts(380),
});
const plain = base({ id: 'm_reply_language', type: 'user', title: 'Answers in Chinese, code comments in English', body: '回复用中文；代码注释、提交信息和标识符保持英文。', updated: ts(2_000) });
const wsEntry = base({ id: 'm_ws_build_cache', type: 'reference', title: 'Build cache lives under .cache/build', body: 'Clearing .cache/build forces a full rebuild; it is safe to delete.', updated: ts(60) });

const source = (id, objectId, payload, locator, minutesAgo) => ({ id, scope: 'memory/global', objectId, payload, locator, learnedAt: ts(minutesAgo) });

export const governanceSeed = {
  authority: { backend: 'sqlite', mode: 'active', epoch: 3 },
  delays: { provenance: 0 },
  provenance: {
    global: {
      m_deploy_workers: {
        sources: [source('source:op-1', 'm_deploy_workers', JSON.stringify({ writer: { writer: 'user' } }), 'session_fixture_memory#turn-2', 9_000)],
        adjudications: [
          { id: 'decision:op-1:m_deploy_workers', scope: 'memory/global', objectId: 'm_deploy_workers', kind: 'correction', revision: revision(original), reason: 'Owner instruction', sourceIds: ['source:op-1'] },
          { id: 'decision:op-2:m_deploy_workers', scope: 'memory/global', objectId: 'm_deploy_workers', kind: 'correction', revision: revision(corrected), reason: 'Owner lowered the worker count after the October incident', sourceIds: ['source:op-1'] },
        ],
        shared: [],
      },
      m_release_freeze: {
        sources: [source('["memory/global","release-note"]', 'm_release_freeze', 'Release checklist: freeze two days before launch; launch owner approves notes.', 'docs/release-checklist.md', 400)],
        adjudications: [], shared: ['m_release_owner'],
      },
      m_release_owner: {
        sources: [source('["memory/global","release-note"]', 'm_release_owner', 'Release checklist: freeze two days before launch; launch owner approves notes.', 'docs/release-checklist.md', 400)],
        adjudications: [], shared: ['m_release_freeze'],
      },
      m_reply_language: {
        sources: [source('source:op-lang', 'm_reply_language', JSON.stringify({ writer: { writer: 'user' } }), undefined, 2_000)],
        adjudications: [], shared: [],
      },
    },
  },
  revisions: { global: { m_deploy_workers: { [revision(original)]: original } } },
};

export default {
  ...memory,
  memoryEntries: {
    ...memory.memoryEntries,
    global: [corrected, releaseA, releaseB, plain],
    [`workspace:${WS_APP}`]: [wsEntry],
  },
  memoryJournal: {
    global: [
      { operationId: 'op_deploy_create', action: 'create', id: 'm_deploy_workers', at: ts(9_000), writer: 'user', before: null, beforeRevision: null, afterRevision: revision(original) },
      { operationId: 'op_deploy_fix', action: 'update', id: 'm_deploy_workers', at: ts(90), writer: 'user',
        before: `---\n${JSON.stringify((({ body: _b, ...rest }) => rest)(original))}\n---\n${original.body}\n`, beforeRevision: revision(original), afterRevision: revision(corrected) },
    ],
  },
  memoryGovernance: governanceSeed,
};
