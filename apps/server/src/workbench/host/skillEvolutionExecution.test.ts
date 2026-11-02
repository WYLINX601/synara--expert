import { ThreadId } from "@synara/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  SkillEvolutionRepository,
  type SkillEvolutionRepositoryShape,
} from "../../experts/evolution/SkillEvolutionRepository";
import {
  ExpertLearningRepository,
  type ExpertLearningRepositoryShape,
} from "../../experts/evolution/ExpertLearningRepository";
import { captureSkillEvolutionExecutionReader } from "./skillEvolutionExecution";

describe("automatic learning native dispatch authorization", () => {
  const modelSelection = { provider: "pi", instanceId: "pi", model: "configured-model" } as const;
  const identity = {
    requestId: "generation",
    ownerId: "owner",
    expertId: "expert",
    origin: "automatic" as const,
    cycleId: "cycle",
    learningEpoch: 3,
    modelSelection,
  };
  async function setup(
    options: {
      enabled?: boolean;
      epoch?: number;
      status?: string;
      generationId?: string;
      ownerId?: string;
    } = {},
  ) {
    const evolution = {
      execution: () => Effect.succeed(identity),
    } as unknown as SkillEvolutionRepositoryShape;
    const learning = {
      readState: () =>
        Effect.succeed({
          ownerId: "owner",
          expertId: "expert",
          revision: 1,
          updatedAt: "2026-10-31T00:00:00.000Z",
          record: JSON.stringify({
            ownerKind: "session",
            state: {
              expertId: "expert",
              enabled: options.enabled ?? true,
              epoch: options.epoch ?? 3,
              revision: 1,
              harnessKind: "pi",
              updatedAt: "2026-10-31T00:00:00.000Z",
            },
          }),
        }),
      readCycle: () =>
        Effect.succeed({
          cycleId: "cycle",
          ownerId: options.ownerId ?? "owner",
          expertId: "expert",
          updatedAt: "2026-10-31T00:00:00.000Z",
          record: JSON.stringify({
            status: options.status ?? "generation",
            discoveryId: "discovery",
            generationId: options.generationId ?? "generation",
          }),
        }),
    } as unknown as ExpertLearningRepositoryShape;
    return Effect.runPromise(
      captureSkillEvolutionExecutionReader.pipe(
        Effect.provideService(SkillEvolutionRepository, evolution),
        Effect.provideService(ExpertLearningRepository, learning),
      ),
    );
  }
  it("permits only the current registered generation and exact model", async () => {
    const read = await setup();
    expect(await Effect.runPromise(read(ThreadId.makeUnsafe("native-thread")))).toEqual(identity);
  });
  it.each([
    { enabled: false },
    { epoch: 5 },
    { status: "failed" },
    { generationId: "new-generation" },
    { ownerId: "other-owner" },
  ])("rejects obsolete or closed queued dispatch %j", async (options) => {
    const read = await setup(options);
    await expect(Effect.runPromise(read(ThreadId.makeUnsafe("native-thread")))).rejects.toThrow(
      "停止原生派发",
    );
  });
  it("reads the enable state after a deferred cycle read, so a concurrent close wins", async () => {
    let beginCycleRead!: () => void;
    let finishCycleRead!: () => void;
    const cycleReadStarted = new Promise<void>((resolve) => (beginCycleRead = resolve));
    const finishCycle = new Promise<void>((resolve) => (finishCycleRead = resolve));
    let epoch = 3;
    const evolution = {
      execution: () => Effect.succeed(identity),
    } as unknown as SkillEvolutionRepositoryShape;
    const learning = {
      readCycle: () =>
        Effect.promise(async () => {
          beginCycleRead();
          await finishCycle;
          return {
            cycleId: "cycle",
            ownerId: "owner",
            expertId: "expert",
            updatedAt: "2026-10-31T00:00:00.000Z",
            record: JSON.stringify({
              status: "generation",
              discoveryId: "discovery",
              generationId: "generation",
            }),
          };
        }),
      readState: () =>
        Effect.succeed({
          ownerId: "owner",
          expertId: "expert",
          revision: 1,
          updatedAt: "2026-10-31T00:00:00.000Z",
          record: JSON.stringify({
            ownerKind: "session",
            state: {
              expertId: "expert",
              enabled: epoch === 3,
              epoch,
              revision: 1,
              harnessKind: "pi",
              updatedAt: "2026-10-31T00:00:00.000Z",
            },
          }),
        }),
    } as unknown as ExpertLearningRepositoryShape;
    const read = await Effect.runPromise(
      captureSkillEvolutionExecutionReader.pipe(
        Effect.provideService(SkillEvolutionRepository, evolution),
        Effect.provideService(ExpertLearningRepository, learning),
      ),
    );

    const result = Effect.runPromiseExit(read(ThreadId.makeUnsafe("native-thread")));
    await cycleReadStarted;
    epoch = 4;
    finishCycleRead();
    const exit = await result;

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("停止原生派发");
  });
  it("fails closed without the learning repository but preserves manual extraction", async () => {
    const repository = {
      execution: () => Effect.succeed(identity),
    } as unknown as SkillEvolutionRepositoryShape;
    const read = await Effect.runPromise(
      captureSkillEvolutionExecutionReader.pipe(
        Effect.provideService(SkillEvolutionRepository, repository),
      ),
    );
    await expect(Effect.runPromise(read(ThreadId.makeUnsafe("native-thread")))).rejects.toThrow(
      "持久授权",
    );
    const manual = { requestId: "manual", ownerId: "owner", modelSelection };
    const manualReader = await Effect.runPromise(
      captureSkillEvolutionExecutionReader.pipe(
        Effect.provideService(SkillEvolutionRepository, {
          execution: () => Effect.succeed(manual),
        } as unknown as SkillEvolutionRepositoryShape),
      ),
    );
    expect(await Effect.runPromise(manualReader(ThreadId.makeUnsafe("manual-thread")))).toEqual(
      manual,
    );
  });
});
