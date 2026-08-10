import { sessionRecord } from './helpers.mjs';

/**
 * Session-list pagination: 125 sessions (> one 100-item page) so the sidebar's
 * "Load more sessions" path (KG-010, before_id keyset) is provable, and the
 * page-1 poll/merge must not duplicate rows.
 */
const sessions = Array.from({ length: 125 }, (_, index) =>
  sessionRecord(`session_fixture_page_${String(index + 1).padStart(3, '0')}`, {
    title: `Fixture: paged session ${String(index + 1).padStart(3, '0')}`,
    // Strictly decreasing recency: page 001 is newest.
    updated_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
  }),
);

export default {
  sessions,
  snapshots: {},
};
