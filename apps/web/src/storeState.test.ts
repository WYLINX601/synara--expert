import { afterEach, describe, expect, it } from "vitest";

import { useStore } from "./store";
import { readShellSnapshotSyncCursor } from "./storeState";

describe("readShellSnapshotSyncCursor", () => {
  const initialCursor = readShellSnapshotSyncCursor(useStore.getState());

  afterEach(() => {
    useStore.setState({
      shellSubscriptionGeneration: initialCursor.subscriptionGeneration,
      shellSnapshotReceivedGeneration: initialCursor.receivedGeneration,
    });
  });

  it("seeds a remounted root effect from the latest generation and accepts its next snapshot", () => {
    const beforeRemountGeneration = initialCursor.subscriptionGeneration + 5;
    useStore
      .getState()
      .setShellSnapshotSyncProgress(beforeRemountGeneration, beforeRemountGeneration - 1);

    const remountedCursor = readShellSnapshotSyncCursor(useStore.getState());
    expect(remountedCursor).toEqual({
      subscriptionGeneration: beforeRemountGeneration,
      receivedGeneration: beforeRemountGeneration - 1,
    });

    const nextGeneration = remountedCursor.subscriptionGeneration + 1;
    useStore
      .getState()
      .setShellSnapshotSyncProgress(nextGeneration, remountedCursor.receivedGeneration);
    useStore.getState().setShellSnapshotSyncProgress(nextGeneration, nextGeneration);

    expect(readShellSnapshotSyncCursor(useStore.getState())).toEqual({
      subscriptionGeneration: nextGeneration,
      receivedGeneration: nextGeneration,
    });
  });
});
