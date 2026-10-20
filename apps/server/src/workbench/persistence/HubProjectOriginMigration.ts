/** Additive extension: a Hub's explicit Project Context source, never inferred. */
export const HUB_PROJECT_ORIGIN_SQL =
  "CREATE TABLE hub_project_origins (hub_id TEXT PRIMARY KEY REFERENCES projection_projects(project_id) ON DELETE CASCADE, source_project_id TEXT NOT NULL)";
