import { RuntimeConfigEditor } from '../RuntimeConfigEditor';

/**
 * Runtime leaf (redesign §10.3): cron display, communication, resources, and
 * task/agent runtime fields. The tools policy card moved to Automation and
 * the MCP timeouts to MCP in the batch-3 split.
 */
export function RuntimeSection() {
  return <RuntimeConfigEditor />;
}
