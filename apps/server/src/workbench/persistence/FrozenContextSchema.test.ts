import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import ContextV1Migration from "../../persistence/Migrations/111_ContextV1.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  CONTEXT_SCHEMA_OBJECTS_QUERY,
  FROZEN_CONTEXT_TABLE_SQL,
  validateFrozenContextSchema,
  type SqliteSchemaObject,
} from "./FrozenContextSchema.ts";
import {
  CONTEXT_TABLE_COLUMNS,
  readWorkbenchSchemaState,
  validateWorkbenchSchemaState,
} from "./WorkbenchMigrations.ts";

const generatedSchema = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 108 });
  yield* ContextV1Migration;
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.unsafe<SqliteSchemaObject>(CONTEXT_SCHEMA_OBJECTS_QUERY);
});

it.effect(
  "keeps complete Context definitions and columns aligned with the frozen Effect on old and current native schemas",
  () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        Object.keys(FROZEN_CONTEXT_TABLE_SQL),
        Object.keys(CONTEXT_TABLE_COLUMNS),
      );
      assert.isNull(validateFrozenContextSchema(true, yield* generatedSchema));
      assert.isNull(
        validateWorkbenchSchemaState({ expert: 0, context: 1 }, yield* readWorkbenchSchemaState),
      );
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      assert.isNull(
        validateFrozenContextSchema(
          true,
          yield* sql.unsafe<SqliteSchemaObject>(CONTEXT_SCHEMA_OBJECTS_QUERY),
        ),
      );
      // SQLite itself adds identifier quotes while saving renamed table DDL.
      for (const table of Object.keys(FROZEN_CONTEXT_TABLE_SQL)) {
        yield* sql.unsafe(`ALTER TABLE ${table} RENAME TO ${table}_renamed`);
        yield* sql.unsafe(`ALTER TABLE ${table}_renamed RENAME TO ${table}`);
      }
      assert.isNull(
        validateFrozenContextSchema(
          true,
          yield* sql.unsafe<SqliteSchemaObject>(CONTEXT_SCHEMA_OBJECTS_QUERY),
        ),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "normalizes identifier quoting and whitespace while preserving constraint string values",
  () =>
    Effect.gen(function* () {
      const objects = yield* generatedSchema;
      for (const [open, close] of [
        ['"', '"'],
        ["`", "`"],
        ["[", "]"],
      ]) {
        const quoted = objects.map((object) =>
          object.name !== "context_thread_bindings"
            ? object
            : {
                ...object,
                sql: object
                  .sql!.replace(
                    /\b(context_thread_bindings|thread_id|mode|snapshot_json)\b/g,
                    (identifier) => `${open}${identifier}${close}`,
                  )
                  .replace("CREATE TABLE", "create  table if not exists"),
              },
        );
        assert.isNull(validateFrozenContextSchema(true, quoted));
      }
      const altered = objects.map((object) =>
        object.name !== "context_thread_bindings"
          ? object
          : {
              type: object.type,
              name: object.name,
              tbl_name: object.tbl_name,
              sql: object.sql!.replace("'bound'", "'BOUND'"),
            },
      );
      assert.isNotNull(validateFrozenContextSchema(true, altered));
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "fails closed on malformed DDL, comments and changed expressions without accepting a CHECK substring",
  () =>
    Effect.gen(function* () {
      const objects = yield* generatedSchema;
      for (const change of [
        (sql: string) => sql.replace("CHECK (mode IN", "/* CHECK */ CHECK (mode IN"),
        (sql: string) => sql.replace("CHECK (mode IN", "CHECK (mode NOT IN"),
        (sql: string) => sql.replace("'bound'", "'bound''"),
        (sql: string) => `${sql}; SELECT 1`,
        (sql: string) => sql.replace("snapshot_json TEXT", "snapshot_json TEXT, CHECK (1 = 1)"),
      ]) {
        assert.isNotNull(
          validateFrozenContextSchema(
            true,
            objects.map((object) =>
              object.name !== "context_thread_bindings"
                ? object
                : { ...object, sql: change(object.sql!) },
            ),
          ),
        );
      }
      const unrelated = {
        type: "trigger",
        name: "unrelated_trigger",
        tbl_name: "unrelated_table",
        sql: "malformed unrelated SQL",
      };
      assert.isNull(validateFrozenContextSchema(true, [...objects, unrelated]));
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("never folds quoted keywords, booleans or literals into constraint tokens", () =>
  Effect.gen(function* () {
    const objects = yield* generatedSchema;
    for (const replacement of [
      '"NULL"',
      "`NULL`",
      "[NULL]",
      "'NULL'",
      "TRUE",
      "FALSE",
      '"TRUE"',
      '"FALSE"',
    ]) {
      const altered = objects.map((object) =>
        object.name !== "context_migrations"
          ? object
          : {
              type: object.type,
              name: object.name,
              tbl_name: object.tbl_name,
              sql: object.sql!.replace("choice IS NULL", `choice IS ${replacement}`),
            },
      );
      assert.isNotNull(validateFrozenContextSchema(true, altered), replacement);
    }
    for (const keyword of ["CHECK", "IN", "OR", "IS", "NULL"]) {
      const altered = objects.map((object) =>
        object.name !== "context_migrations"
          ? object
          : {
              type: object.type,
              name: object.name,
              tbl_name: object.tbl_name,
              sql: object.sql!.replace(new RegExp(`\\b${keyword}\\b`), `"${keyword}"`),
            },
      );
      assert.isNotNull(validateFrozenContextSchema(true, altered), keyword);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
