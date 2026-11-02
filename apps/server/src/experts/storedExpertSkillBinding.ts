import { ExpertSkillBinding } from "@synara/contracts";
import { Schema } from "effect";

/** Storage projection for historical binding records; authoring stays strict. */
export const StoredExpertSkillBinding = Schema.Struct(ExpertSkillBinding.fields);
export const StoredExpertSkillBindings = Schema.Array(StoredExpertSkillBinding).check(
  Schema.isMaxLength(100),
);

export function decodeStoredExpertSkillBindings(value: unknown) {
  return Schema.decodeUnknownSync(StoredExpertSkillBindings)(value);
}
