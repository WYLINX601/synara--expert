/** Actual accepted renderer persistence work, not a second draft queue. */
let activeOperations = 0;
const listeners = new Set<() => void>();
let updateLease: { attemptId: string; digest: string } | null = null;

export function freezeComposerPersistenceForUpdate(attemptId: string, digest: string): boolean {
  if (updateLease && (updateLease.attemptId !== attemptId || updateLease.digest !== digest))
    return false;
  updateLease = { attemptId, digest };
  return true;
}

export function releaseComposerPersistenceForUpdate(attemptId: string, digest: string): void {
  if (updateLease?.attemptId === attemptId && updateLease.digest === digest) updateLease = null;
}

/** Producers check before accepting work; already accepted work must still finish. */
export function assertComposerPersistenceAllowed(): void {
  if (updateLease) throw new Error("Editing is paused while preparing the update.");
}

export function isComposerPersistenceUpdateFrozen(): boolean {
  return updateLease !== null;
}

export function notifyComposerPersistenceChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* Observers cannot cancel already accepted persistence. */
    }
  }
}
export function beginComposerPersistenceOperation(): () => void {
  activeOperations += 1;
  // Revoke synchronously before an accepted write can cross the handoff boundary.
  notifyComposerPersistenceChanged();
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    activeOperations -= 1;
    notifyComposerPersistenceChanged();
  };
}

export function composerPersistenceOperationCount(): number {
  return activeOperations;
}

export function subscribeComposerPersistenceOperations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
