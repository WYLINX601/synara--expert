import { LinxUpdateSourceCommit } from "@synara/contracts";
import { Schema } from "effect";
import type { LinxReleaseCandidate } from "./linx-release-candidate.ts";

const GitObject = Schema.Struct({
  type: Schema.Literals(["commit", "tag"]),
  sha: LinxUpdateSourceCommit,
});
const Reference = Schema.Struct({ ref: Schema.String, object: GitObject });
const Tag = Schema.Struct({ sha: LinxUpdateSourceCommit, object: GitObject });

/** Reuse the release CLI's API transport, including its explicit anonymous mode. */
export async function verifyLinxReleaseOperation(input: {
  release: { tag_name: string; target_commitish: string; prerelease: boolean };
  candidate: Pick<LinxReleaseCandidate, "tag" | "sourceCommit">;
  api: (path: string, options: { anonymous: boolean }) => Promise<unknown>;
  anonymous?: boolean;
  verify: () => Promise<void>;
  publish?: () => Promise<void>;
}): Promise<void> {
  const { release, candidate, api, verify, publish, anonymous = false } = input;
  if (
    release.tag_name !== candidate.tag ||
    release.target_commitish !== candidate.sourceCommit ||
    release.prerelease
  )
    throw new Error("Release source changed.");

  async function verifyTag(): Promise<void> {
    const reference = Schema.decodeUnknownSync(Reference)(
      await api(`git/ref/tags/${encodeURIComponent(candidate.tag)}`, { anonymous }),
    );
    if (reference.ref !== `refs/tags/${candidate.tag}`)
      throw new Error("The Linx tag reference changed.");
    let object = reference.object;
    // Match the desktop receipt resolver: at most five annotated objects, ending in a commit.
    for (let depth = 0; object.type === "tag"; depth += 1) {
      if (depth >= 5) throw new Error("The Linx annotated tag chain exceeds the allowed depth.");
      const tag = Schema.decodeUnknownSync(Tag)(await api(`git/tags/${object.sha}`, { anonymous }));
      if (tag.sha !== object.sha)
        throw new Error("The Linx annotated tag response changed identity.");
      object = tag.object;
    }
    if (object.sha !== candidate.sourceCommit)
      throw new Error("The Linx tag does not name the immutable candidate source commit.");
  }

  await verifyTag();
  await verify();
  // Asset hashing/restoration can be lengthy. Resolve afresh before publishing or success.
  await verifyTag();
  if (publish) {
    await publish();
    // A successful PATCH is not proof that the source remained fixed during publication.
    await verifyTag();
  }
}
