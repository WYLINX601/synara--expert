import { SuiteImportRequest, SuitePreview } from "@synara/contracts";
import { Schema } from "effect";

const STORAGE_KEY = "synara:suite-import:pending:v1";
const SuiteImportJournal = Schema.Struct({
  request: SuiteImportRequest,
  preview: SuitePreview,
  github: Schema.String,
  folder: Schema.String,
  channel: Schema.Literals(["github", "local-folder"]),
});
export type SuiteImportJournal = typeof SuiteImportJournal.Type;

export function readSuiteImportJournal(
  storage: Pick<Storage, "getItem"> = localStorage,
): SuiteImportJournal | null {
  const raw = storage.getItem(STORAGE_KEY);
  return raw === null ? null : Schema.decodeUnknownSync(SuiteImportJournal)(JSON.parse(raw));
}

export function writeSuiteImportJournal(
  journal: SuiteImportJournal,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(journal));
}

export function clearSuiteImportJournal(storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(STORAGE_KEY);
}
