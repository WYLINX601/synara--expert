/** Additive Expert workbench extension for each Hub's explicit expert roster. */
export const HUB_EXPERT_PARTICIPANTS_SQL =
  "CREATE TABLE hub_expert_participants (hub_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE, expert_id TEXT NOT NULL, PRIMARY KEY (hub_id, expert_id))";
