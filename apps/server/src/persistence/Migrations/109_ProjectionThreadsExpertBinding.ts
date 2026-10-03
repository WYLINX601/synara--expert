import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* columnExists(sql, "projection_threads", "expert_binding_json")) return;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN expert_binding_json TEXT`;
});
