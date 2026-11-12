import { createHash } from "node:crypto";

/** New Suite identities only; legacy Expert/pkg_ fingerprints must not change. */
export function canonicalSuiteJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index++)
      entries.push(canonicalSuiteJson(value[index]));
    return `[${entries.join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("Suite content must contain only JSON values.");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSuiteJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Suite content must contain only finite, defined JSON values.");
}

export function suiteContentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSuiteJson(value), "utf8").digest("hex");
}
