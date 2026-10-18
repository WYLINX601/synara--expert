/** Read-only schema identities belonging to the unchanged legacy Context 111 effect. */
export interface SqliteSchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

// Both the live Effect connection and the read-only backup reader use this query.
export const CONTEXT_SCHEMA_OBJECTS_QUERY =
  "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name";

export const FROZEN_CONTEXT_TABLE_SQL: Readonly<Record<string, string>> = {
  context_meta: `CREATE TABLE context_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    data_instance_id TEXT NOT NULL
  )`,
  context_spaces: `CREATE TABLE context_spaces (
    space_id TEXT PRIMARY KEY,
    direction_goal TEXT NOT NULL DEFAULT '',
    shared_instructions TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at TEXT NOT NULL
  )`,
  context_projects: `CREATE TABLE context_projects (
    project_id TEXT PRIMARY KEY,
    project_goal TEXT NOT NULL DEFAULT '',
    project_instructions TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at TEXT NOT NULL
  )`,
  context_migrations: `CREATE TABLE context_migrations (
    project_id TEXT PRIMARY KEY,
    source_digest TEXT NOT NULL,
    legacy_instructions TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'conflict', 'completed')),
    choice TEXT CHECK (choice IS NULL OR choice IN ('keep_saved', 'use_legacy')),
    updated_at TEXT NOT NULL
  )`,
  context_thread_bindings: `CREATE TABLE context_thread_bindings (
    thread_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('legacy', 'unbound', 'bound')),
    snapshot_json TEXT
  )`,
  context_applied_runtime_records: `CREATE TABLE context_applied_runtime_records (
    thread_id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL
  )`,
  context_command_results: `CREATE TABLE context_command_results (
    command_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL
  )`,
};

export const FROZEN_CONTEXT_DELIVERY_DEFINITIONS = [
  "context_snapshot_id TEXT",
  "context_input_digest TEXT",
  "context_message_id TEXT",
  `context_phase TEXT CHECK (context_phase IS NULL OR context_phase IN (
    'before_dispatch', 'dispatch_started', 'acknowledged'
  ))`,
] as const;

const deliveryTable = "orchestration_event_deliveries";
const deliveryIndexes: Readonly<Record<string, string>> = {
  idx_orchestration_event_deliveries_state_sequence: `CREATE INDEX idx_orchestration_event_deliveries_state_sequence
      ON orchestration_event_deliveries(consumer_name, state, event_sequence)`,
  idx_orchestration_event_deliveries_thread_state: `CREATE INDEX idx_orchestration_event_deliveries_thread_state
      ON orchestration_event_deliveries(consumer_name, thread_id, state, event_sequence)`,
};

interface SqlToken {
  readonly kind: "word" | "identifier" | "literal" | "symbol";
  readonly value: string;
}

/**
 * Keep quoted identifiers distinct from bare SQL keywords: SQLite can treat
 * an unresolved double-quoted identifier as a string. Only the comparison at
 * known identifier positions may normalize quotes. Literal values stay exact;
 * comments, unterminated quotes and unknown syntax fail closed.
 */
function tokenize(sql: string): readonly SqlToken[] | null {
  const tokens: SqlToken[] = [];
  for (let index = 0; index < sql.length; ) {
    const char = sql[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index) || sql.startsWith("/*", index)) return null;
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const end = char === "[" ? "]" : char;
      let value = "";
      let closed = false;
      index += 1;
      while (index < sql.length) {
        const next = sql[index++]!;
        if (next !== end) {
          value += next;
          continue;
        }
        if (char !== "[" && sql[index] === end) {
          value += end;
          index += 1;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) return null;
      tokens.push({
        kind: char === "'" ? "literal" : "identifier",
        value,
      });
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(sql.slice(index));
    if (word) {
      tokens.push({ kind: "word", value: word[0].toLowerCase() });
      index += word[0].length;
      continue;
    }
    if (/[0-9(),;=<>+*-]/.test(char)) {
      tokens.push({ kind: "symbol", value: char });
      index += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

const isWord = (token: SqlToken | undefined, value: string) =>
  token?.kind === "word" && token.value === value;
const isIdentifier = (token: SqlToken | undefined, value: string) =>
  token !== undefined &&
  (token.kind === "word" || token.kind === "identifier") &&
  token.value.toLowerCase() === value;

function sameTokens(
  actual: readonly SqlToken[],
  expected: readonly SqlToken[],
  knownIdentifiers: ReadonlySet<string>,
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((token, index) => {
      const wanted = expected[index]!;
      if (token.kind === wanted.kind && token.value === wanted.value) return true;
      // The expected token must refer to a real frozen column/table/index name,
      // never NULL, TRUE, FALSE, IN, CHECK, a type name, or a literal value.
      return (
        token.kind === "identifier" &&
        wanted.kind === "word" &&
        knownIdentifiers.has(wanted.value) &&
        token.value.toLowerCase() === wanted.value
      );
    })
  );
}

function tableDefinitions(sql: string, table: string): readonly (readonly SqlToken[])[] | null {
  const tokens = tokenize(sql);
  if (!tokens || !isWord(tokens[0], "create") || !isWord(tokens[1], "table")) return null;
  let index = 2;
  if (
    isWord(tokens[index], "if") &&
    isWord(tokens[index + 1], "not") &&
    isWord(tokens[index + 2], "exists")
  )
    index += 3;
  if (!isIdentifier(tokens[index++], table) || tokens[index++]?.value !== "(") return null;
  const definitions: SqlToken[][] = [];
  let definition: SqlToken[] = [];
  let depth = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "symbol" && token.value === ")" && depth === 0) {
      if (definition.length === 0) return null;
      definitions.push(definition);
      const rest = tokens.slice(index + 1);
      return rest.length === 0 || (rest.length === 1 && rest[0]?.value === ";")
        ? definitions
        : null;
    }
    if (token.kind === "symbol" && token.value === "," && depth === 0) {
      if (definition.length === 0) return null;
      definitions.push(definition);
      definition = [];
      continue;
    }
    if (token.kind === "symbol" && token.value === "(") depth += 1;
    if (token.kind === "symbol" && token.value === ")") depth -= 1;
    if (depth < 0 || token.value === ";") return null;
    definition.push(token);
  }
  return null;
}

function indexTokens(sql: string): readonly SqlToken[] | null {
  const tokens = tokenize(sql);
  if (!tokens || !isWord(tokens[0], "create") || !isWord(tokens[1], "index")) return null;
  const normalized = [...tokens];
  if (
    isWord(normalized[2], "if") &&
    isWord(normalized[3], "not") &&
    isWord(normalized[4], "exists")
  )
    normalized.splice(2, 3);
  if (normalized.at(-1)?.value === ";") normalized.pop();
  return normalized;
}

/** Pure comparison shared by live adoption, startup and read-only backup recognition. */
export function validateFrozenContextSchema(
  contextApplied: boolean,
  objects: readonly SqliteSchemaObject[],
): string | null {
  const tableNames = Object.keys(FROZEN_CONTEXT_TABLE_SQL);
  const protectedObjects = objects.filter(
    ({ tbl_name, name }) =>
      tableNames.includes(tbl_name) ||
      tableNames.includes(name) ||
      tbl_name === deliveryTable ||
      name === deliveryTable,
  );
  if (contextApplied) {
    for (const table of tableNames) {
      const found = protectedObjects.filter(({ name }) => name === table);
      const actual = found[0];
      const definitions = actual?.sql ? tableDefinitions(actual.sql, table) : null;
      const expected = tableDefinitions(FROZEN_CONTEXT_TABLE_SQL[table]!, table);
      const knownColumns = new Set(expected?.map((column) => column[0]!.value));
      if (
        found.length !== 1 ||
        actual?.type !== "table" ||
        !definitions ||
        expected === null ||
        definitions.length !== expected.length ||
        definitions.some(
          (definition, index) => !sameTokens(definition, expected[index]!, knownColumns),
        )
      ) {
        return `Context table ${table} does not match the frozen Context V1 definition.`;
      }
    }
  } else if (
    protectedObjects.some(
      ({ name, tbl_name }) => tableNames.includes(name) || tableNames.includes(tbl_name),
    )
  ) {
    return "Context V1 schema objects exist without a matching context workbench migration record.";
  }

  const delivery = protectedObjects.find(
    ({ type, name }) => type === "table" && name === deliveryTable,
  );
  const definitions = delivery?.sql ? tableDefinitions(delivery.sql, deliveryTable) : null;
  const expectedDefinitions = FROZEN_CONTEXT_DELIVERY_DEFINITIONS.map((sql) => tokenize(sql)!);
  const contextColumns = new Set(expectedDefinitions.map((definition) => definition[0]!.value));
  if (delivery && !definitions) return "The delivery table SQL cannot be recognized safely.";
  const actualContext = (definitions ?? []).filter((definition) =>
    definition.some(
      (token) =>
        (token.kind === "word" || token.kind === "identifier") &&
        contextColumns.has(token.value.toLowerCase()),
    ),
  );
  if (contextApplied) {
    if (
      actualContext.length !== expectedDefinitions.length ||
      actualContext.some(
        (definition, index) => !sameTokens(definition, expectedDefinitions[index]!, contextColumns),
      )
    ) {
      return "The delivery Context V1 definitions do not match the frozen columns and CHECK constraint.";
    }
  } else if (actualContext.length > 0) {
    return "Context V1 delivery definitions exist without a matching context workbench migration record.";
  }

  for (const object of protectedObjects) {
    if (object.type === "table") continue;
    const autoIndex =
      object.type === "index" &&
      object.sql === null &&
      object.name === `sqlite_autoindex_${object.tbl_name}_1` &&
      (object.tbl_name === deliveryTable || (contextApplied && object.tbl_name !== "context_meta"));
    const officialIndexSql = deliveryIndexes[object.name];
    const officialIndex =
      object.type === "index" &&
      object.tbl_name === deliveryTable &&
      object.sql !== null &&
      officialIndexSql !== undefined &&
      sameTokens(
        indexTokens(object.sql) ?? [],
        indexTokens(officialIndexSql)!,
        new Set([
          object.name,
          deliveryTable,
          "consumer_name",
          "state",
          "event_sequence",
          "thread_id",
        ]),
      );
    if (!autoIndex && !officialIndex)
      return `Unsupported schema object ${object.name} is attached to a protected Context table.`;
  }
  return null;
}
