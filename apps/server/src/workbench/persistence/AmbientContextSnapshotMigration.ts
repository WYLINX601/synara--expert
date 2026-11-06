/** Canonical SQL for adding immutable Ambient Context snapshots to messages. */
export const AMBIENT_CONTEXT_SNAPSHOT_SQL =
  "ALTER TABLE projection_thread_messages ADD COLUMN ambient_context_json TEXT";
