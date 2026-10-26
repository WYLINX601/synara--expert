import { describe, expect, it } from "vitest";
import type { ProviderSession } from "@synara/contracts";
import { WorkerContextDelivery } from "./workerTurnContext.ts";

const session = { provider: "codex", lifecycleGeneration: "one" } as ProviderSession;
const sections = [
  { label: "Instructions", text: "Preserve user constraints." },
  { label: "Inputs", text: "owner=author path=result.md revision=2" },
];

describe("WorkerContextDelivery", () => {
  it("sends a full packet until the matching successful turn completes", () => {
    const delivery = new WorkerContextDelivery();
    const first = delivery.prepare("worker", session, sections);
    expect(first.text).toContain(sections[0]!.text);
    first.accepted("turn-1");
    delivery.complete("worker", "old-turn", true);
    const beforeCompletion = delivery.prepare("other-worker", session, sections);
    expect(beforeCompletion.text).toContain(sections[0]!.text);
    delivery.complete("worker", "turn-1", true);
    expect(delivery.prepare("worker", session, sections).text).toBe("");
    expect(delivery.prepare("other-worker", session, sections).text).not.toBe("");
  });

  it("emits only changed sections and explicit removals", () => {
    const delivery = new WorkerContextDelivery();
    delivery.prepare("worker", session, sections).accepted("first");
    delivery.complete("worker", "first", true);
    const update = delivery.prepare("worker", session, [
      { label: "Instructions", text: "Use the approved scope." },
    ]);
    expect(update.text).toContain("Use the approved scope.");
    expect(update.text).not.toContain("Preserve user constraints.");
    expect(update.text).toContain("## Inputs\nRemoved from current task context");
  });

  it("replays after failure, abort, reset, generation or provider changes", () => {
    for (const mode of [
      "send-failed",
      "turn-failed",
      "reset",
      "generation",
      "provider",
      "compact",
    ] as const) {
      const delivery = new WorkerContextDelivery();
      delivery.prepare("worker", session, sections).accepted("first");
      delivery.complete("worker", "first", true);
      let nextSession = session;
      if (mode === "send-failed") delivery.prepare("worker", session, sections).failed();
      if (mode === "turn-failed") {
        delivery.prepare("worker", session, sections).accepted("bad");
        delivery.complete("worker", "bad", false);
      }
      if (mode === "generation") nextSession = { ...session, lifecycleGeneration: "two" };
      if (mode === "provider") nextSession = { ...session, provider: "claudeAgent" };
      if (mode === "compact") delivery.forget("worker");
      expect(
        delivery.prepare("worker", nextSession, sections, mode === "reset").text,
        mode,
      ).toContain(sections[0]!.text);
    }
  });

  it("handles a terminal arriving before sendTurn acknowledges", () => {
    const delivery = new WorkerContextDelivery();
    const first = delivery.prepare("worker", session, sections);
    delivery.complete("worker", "early", true);
    delivery.complete("worker", "unrelated-old-turn", false);
    first.accepted("early");
    expect(delivery.prepare("worker", session, sections).text).toBe("");
  });

  it("does not cache unknown runtime generations or reuse receipts after restart", () => {
    const delivery = new WorkerContextDelivery();
    const unknown = { provider: "codex" } as ProviderSession;
    delivery.prepare("worker", unknown, sections).accepted("first");
    delivery.complete("worker", "first", true);
    expect(delivery.prepare("worker", unknown, sections).text).not.toBe("");
    delivery.prepare("worker", session, sections).accepted("second");
    delivery.complete("worker", "second", true);
    expect(new WorkerContextDelivery().prepare("worker", session, sections).text).not.toBe("");
  });

  it("ignores a stale runtime generation even when a provider reuses its turn ID", () => {
    const delivery = new WorkerContextDelivery();
    delivery.prepare("worker", session, sections).accepted("same-id");
    delivery.complete("worker", "same-id", true, { provider: "codex", lifecycleGeneration: "old" });
    expect(delivery.prepare("worker", session, sections).text).not.toBe("");
  });

  it("does not acknowledge an invalidated compaction-era send", () => {
    const delivery = new WorkerContextDelivery();
    const stale = delivery.prepare("worker", session, sections);
    delivery.forget("worker");
    stale.accepted("stale");
    delivery.complete("worker", "stale", true);
    expect(delivery.prepare("worker", session, sections).text).not.toBe("");
  });
});

it("replays the full frozen assignment after reset and omits only an exact current message", () => {
  const delivery = new WorkerContextDelivery();
  const frozen =
    "Task brief and hard constraint. owner=author path=result.md revision=2; planId=plan attemptId=attempt";
  const packet = [...sections, { label: "Frozen assignment and sources", text: frozen }];
  const first = delivery.prepare("worker", session, packet, false, frozen);
  expect(first.text).not.toContain(frozen);
  first.accepted("initial");
  delivery.complete("worker", "initial", true);
  expect(delivery.prepare("worker", session, packet).text).toBe("");
  expect(delivery.prepare("worker", session, packet, true).text).toContain(frozen);
  expect(delivery.prepare("worker", session, packet, true, "quoted fragment").text).toContain(
    frozen,
  );
});
