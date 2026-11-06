import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectionThreadMessageDbRowSchema,
  orchestrationMessageFromProjectionRow,
  projectionThreadMessageFromRow,
} from "./projectionThreadMessageRow.ts";

const ambientContext = {
  schemaVersion: 1 as const,
  id: "snapshot-1",
  capturedAt: "2026-07-20T10:00:00.000Z",
  items: [
    {
      observation: {
        schemaVersion: 1 as const,
        id: "observation-1",
        targetKey: "target-1",
        capturedAt: "2026-07-20T10:00:00.000Z",
        method: "selection event",
        confidence: "exact" as const,
        type: "selection.text" as const,
        value: { text: "selected evidence" },
      },
      provenance: [
        {
          sourceId: "source-1",
          observationId: "observation-1",
          capturedAt: "2026-07-20T10:00:00.000Z",
          method: "selection event",
          confidence: "exact" as const,
        },
      ],
      ambiguous: false,
    },
  ],
};

const decodeRow = Schema.decodeUnknownSync(ProjectionThreadMessageDbRowSchema);

const baseRow = {
  messageId: "message-row-1",
  threadId: "thread-row-1",
  turnId: "turn-row-1",
  role: "user",
  text: "Use @github with $check-code",
  ambientContext: JSON.stringify(ambientContext),
  attachments: JSON.stringify([
    {
      type: "file",
      id: "attachment-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    },
  ]),
  skills: JSON.stringify([
    {
      name: "check-code",
      path: "/skills/check-code/SKILL.md",
    },
  ]),
  mentions: JSON.stringify([
    {
      name: "github",
      path: "plugin://github",
    },
  ]),
  dispatchMode: "steer",
  dispatchOrigin: "automation",
  startsNewTurn: 1,
  isStreaming: 1,
  source: "native",
  sequence: 42,
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-20T10:00:01.000Z",
};

describe("projection thread message row codec", () => {
  it("decodes JSON metadata and preserves repository-only dispatch and sequence fields", () => {
    const row = decodeRow(baseRow);
    const message = projectionThreadMessageFromRow(row);

    expect(message).toMatchObject({
      messageId: "message-row-1",
      threadId: "thread-row-1",
      turnId: "turn-row-1",
      role: "user",
      text: "Use @github with $check-code",
      ambientContext,
      attachments: [{ type: "file", id: "attachment-1", name: "notes.txt" }],
      skills: [{ name: "check-code", path: "/skills/check-code/SKILL.md" }],
      mentions: [{ name: "github", path: "plugin://github" }],
      dispatchMode: "steer",
      dispatchOrigin: "automation",
      startsNewTurn: true,
      isStreaming: true,
      source: "native",
      sequence: 42,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:01.000Z",
    });
  });

  it("maps the same decoded row directly to orchestration shape and omits nullable optionals", () => {
    const projected = orchestrationMessageFromProjectionRow(decodeRow(baseRow));
    expect(projected).toMatchObject({
      id: "message-row-1",
      turnId: "turn-row-1",
      streaming: true,
      attachments: [{ id: "attachment-1" }],
      ambientContext,
      skills: [{ name: "check-code" }],
      mentions: [{ name: "github" }],
      dispatchMode: "steer",
      dispatchOrigin: "automation",
      startsNewTurn: true,
    });
    expect("sequence" in projected).toBe(false);

    const nullRow = decodeRow({
      ...baseRow,
      turnId: null,
      attachments: null,
      ambientContext: null,
      skills: null,
      mentions: null,
      dispatchMode: null,
      dispatchOrigin: null,
      startsNewTurn: null,
      isStreaming: 0,
      sequence: null,
    });
    const repositoryMessage = projectionThreadMessageFromRow(nullRow);
    const orchestrationMessage = orchestrationMessageFromProjectionRow(nullRow);

    expect(repositoryMessage).toMatchObject({
      turnId: null,
      isStreaming: false,
    });
    expect(orchestrationMessage).toMatchObject({
      turnId: null,
      streaming: false,
    });
    for (const optionalField of [
      "attachments",
      "ambientContext",
      "skills",
      "mentions",
      "dispatchMode",
      "dispatchOrigin",
      "startsNewTurn",
      "sequence",
    ]) {
      expect(optionalField in repositoryMessage).toBe(false);
      expect(optionalField in orchestrationMessage).toBe(false);
    }
  });

  it("rejects invalid persisted JSON before either converter runs", () => {
    for (const field of ["ambientContext", "attachments", "skills", "mentions"] as const) {
      expect(() =>
        decodeRow({
          ...baseRow,
          [field]: "{not-json",
        }),
      ).toThrow();
    }
  });
});
