import { describe, expect, it } from "vitest";

import {
  buildHubDeliverableReferenceUri,
  buildHubExpertReferenceUri,
  isHubReferenceUri,
  parseHubReferenceUri,
  splitHubReferenceMentions,
} from "./hubReferences";

describe("Hub reference URIs", () => {
  it("round trips stable Expert ids and exact publication references", () => {
    expect(buildHubExpertReferenceUri("writer_1")).toBe("synara://expert/writer_1");
    expect(parseHubReferenceUri("synara://expert/writer_1")).toEqual({
      kind: "expert",
      expertId: "writer_1",
    });

    const uri = buildHubDeliverableReferenceUri({
      hubId: "hub&one",
      workerThreadId: "worker-1",
      path: "research/final draft #1.md",
      revision: 3,
    });
    expect(uri).toBe(
      "synara://hub/hub%26one/deliverables/worker-1/research/final%20draft%20%231.md?revision=3",
    );
    expect(parseHubReferenceUri(uri)).toEqual({
      kind: "deliverable",
      hubId: "hub&one",
      workerThreadId: "worker-1",
      path: "research/final draft #1.md",
      revision: 3,
    });
  });

  it("rejects incomplete, noncanonical, traversing, and nonpositive references", () => {
    for (const uri of [
      "synara://expert/Bad",
      "synara://expert/writer_1?revision=1",
      "synara://hub/hub-1/deliverables/worker-1/report.md",
      "synara://hub/hub-1/deliverables/worker-1/../secret.md?revision=1",
      "synara://hub/hub-1/deliverables/worker-1/%2E%2E/secret.md?revision=1",
      "synara://hub/hub-1/deliverables/worker-1/report.md?revision=0",
      "synara://hub/hub-1/deliverables/worker-1/report.md?revision=01",
      "synara://hub/hub-1/deliverables/worker-1/report.md?revision=1&revision=2",
      "SYNARA://expert/writer_1",
      "synara:unknown/reference",
    ]) {
      expect(parseHubReferenceUri(uri), uri).toBeNull();
      expect(isHubReferenceUri(uri), uri).toBe(true);
    }
    expect(() =>
      buildHubDeliverableReferenceUri({
        hubId: "hub-1",
        workerThreadId: "worker-1",
        path: "../secret.md",
        revision: 1,
      }),
    ).toThrow("source path is invalid");
    expect(() =>
      buildHubDeliverableReferenceUri({
        hubId: "hub-1",
        workerThreadId: "worker-1",
        path: "report.md",
        revision: 0,
      }),
    ).toThrow("positive integer");
  });

  it("separates app references from filesystem references without leaking malformed app URIs", () => {
    expect(
      splitHubReferenceMentions([
        { name: "Draft", path: "/workspace/draft.md" },
        { name: "Windows draft", path: "C:\\workspace\\draft.md" },
        { name: "Report", path: "synara://hub/hub-1/deliverables/worker-1/report.md?revision=2" },
        { name: "Broken", path: "synara://hub/hub-1/deliverables/worker-1/report.md" },
      ]),
    ).toEqual({
      references: [
        {
          mention: {
            name: "Report",
            path: "synara://hub/hub-1/deliverables/worker-1/report.md?revision=2",
          },
          reference: {
            kind: "deliverable",
            hubId: "hub-1",
            workerThreadId: "worker-1",
            path: "report.md",
            revision: 2,
          },
        },
      ],
      providerMentions: [
        { name: "Draft", path: "/workspace/draft.md" },
        { name: "Windows draft", path: "C:\\workspace\\draft.md" },
      ],
      invalidMentions: [
        { name: "Broken", path: "synara://hub/hub-1/deliverables/worker-1/report.md" },
      ],
    });
  });
});
